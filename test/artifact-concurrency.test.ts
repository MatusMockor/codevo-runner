import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { ArtifactService } from '../src/application/artifact-service.js';
import { FileArtifactBlobs } from '../src/infrastructure/artifacts/blobs.js';
import { WorkspaceArtifactReader } from '../src/infrastructure/artifacts/workspace.js';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'runner-artifact-concurrent-'));
  const source = join(root, 'source');
  await mkdir(source);
  const exec = promisify(execFile);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'design.html'), '<h1>Snapshot</h1>');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const data = join(root, 'data');
  const repository = await openSqliteRepository(data, randomUUID());
  t.after(async () => { await repository.close(); await rm(root, { recursive: true, force: true }); });
  const project = { id: 'sample', name: 'Sample', path: source };
  const workspaces = new GitProjectWorkspace(data);
  const service = new ArtifactService(repository, repository,
    new WorkspaceArtifactReader(repository, repository, new ConfiguredProjectRegistry([project]), workspaces, join(data, 'workspaces')),
    await FileArtifactBlobs.open(data, []));
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Design' }], isolation: 'in-place' })).task;
    await repository.queueTask(task.id, project.id);
    await repository.claimNextTask();
    await workspaces.prepare(project, task.id, undefined, 'in-place');
    ids.push(task.id);
  }
  return { service, ids, repository, data };
}

test('concurrent output captures queue fairly and retain immutable per-task snapshots', { timeout: 30_000 }, async t => {
  const { service, ids, data } = await fixture(t);
  const captures = Array.from({ length: 64 }, (_, index) => service.captureOutput(ids[index % 2]!, ['design.html']));
  assert.equal(await service.captureOutput(ids[0]!, ['design.html']), false, 'admission is bounded at 64');
  await assert.rejects(service.register(ids[0]!, { path: 'design.html' }), { code: 'busy' });
  assert.deepEqual(await Promise.all(captures), Array(64).fill(true));
  const artifacts = await Promise.all(ids.map(async id => (await service.list(id)).items));
  assert.deepEqual(artifacts.map(items => items.length), [1, 1]);
  assert.notEqual(artifacts[0]![0]!.id, artifacts[1]![0]!.id);
  assert.equal((await readdir(join(data, 'artifacts'))).length, 2);
  for (const id of ids) {
    const artifact = (await service.list(id)).items[0]!;
    assert.equal(Buffer.from((await service.read(id, artifact.id)).bytes).toString(), '<h1>Snapshot</h1>');
  }
});

test('expired captures leave the admission queue and cannot publish late snapshots', { timeout: 30_000 }, async t => {
  const { service, ids } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const captures = Array.from({ length: 64 }, () => service.captureOutput(ids[0]!, ['design.html']));
  t.mock.timers.tick(30_001);
  assert.deepEqual(await Promise.all(captures), Array(64).fill(false));
  t.mock.timers.reset();
  assert.deepEqual((await service.list(ids[0]!)).items, []);
  assert.equal(await service.captureOutput(ids[1]!, ['design.html']), true);
});

test('failed captures release admission for subsequent queued work', { timeout: 30_000 }, async t => {
  const { service, ids } = await fixture(t);
  const missing = service.captureOutput(ids[0]!, ['missing.html']);
  const valid = service.captureOutput(ids[1]!, ['design.html']);
  assert.equal(await missing, false);
  assert.equal(await valid, true);
  assert.deepEqual((await service.list(ids[0]!)).items, []);
  assert.equal((await service.list(ids[1]!)).items.length, 1);
});
