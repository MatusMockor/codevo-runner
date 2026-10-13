import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { FolderProjectWorkspace } from '../src/infrastructure/projects/folder-workspace.js';
import { ProjectWorkspaceRouter } from '../src/infrastructure/projects/workspace-router.js';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-workspace-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const project = { id: 'sample', name: 'Sample', path: source };
  const data = join(root, 'data');
  const workspace = new GitProjectWorkspace(data);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  return { root, source, project, data, workspace, taskId, cwd };
}

test('resuming after adapter restart preserves committed and uncommitted first-turn files', async t => {
  const { source, project, data, taskId, cwd } = await fixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'first turn\n');
  await exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'first turn']);
  await writeFile(join(cwd, 'pending.txt'), 'pending edit\n');
  const restarted = new GitProjectWorkspace(data);
  assert.equal(await restarted.resume(project, taskId), cwd);
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'first turn\n');
  assert.equal(await readFile(join(cwd, 'pending.txt'), 'utf8'), 'pending edit\n');
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'original\n');
  assert.match((await restarted.diff(taskId)).patch, /first turn/);
});

for (const replacement of ['missing', 'foreign', 'symlink'] as const) {
  test(`resume rejects ${replacement} worktree without recreating or modifying it`, async t => {
    const { root, project, workspace, taskId, cwd } = await fixture(t);
    await rm(cwd, { recursive: true, force: true });
    if (replacement === 'foreign') {
      await exec('git', ['init', cwd]);
      await writeFile(join(cwd, 'foreign.txt'), 'keep me');
    }
    if (replacement === 'symlink') await symlink(join(root, 'source'), cwd);
    await assert.rejects(workspace.resume(project, taskId));
    if (replacement === 'foreign') assert.equal(await readFile(join(cwd, 'foreign.txt'), 'utf8'), 'keep me');
  });
}

test('resume fails closed on missing baseline and pre-aborted operation', async t => {
  const { project, data, workspace, taskId } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.resume(project, taskId, controller.signal), { name: 'AbortError' });
  await rm(join(data, 'workspace-baselines', taskId));
  await assert.rejects(workspace.resume(project, taskId));
});

async function folderFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codevo-folder-resume-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'folder');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'first turn\n');
  const project = { id: 'folder', name: 'Folder', path: folder, kind: 'folder' as const };
  const data = join(root, 'data');
  const router = () => new ProjectWorkspaceRouter(data, new GitProjectWorkspace(data), new FolderProjectWorkspace(data));
  const workspace = router();
  const taskId = randomUUID();
  await workspace.prepare(project, taskId, undefined, 'in-place');
  return { root, folder, project, data, router, workspace, taskId, record: join(data, 'workspace-metadata', taskId) };
}

test('a folder task resumes after restart with the files its first turn left behind', async t => {
  const { folder, project, router, taskId, record } = await folderFixture(t);
  await writeFile(join(folder, 'pending.txt'), 'pending edit\n');
  const stored = JSON.parse(await readFile(record, 'utf8')) as { sourceIdentity: { dev: number; ino: number } };
  await writeFile(record, JSON.stringify({ ...stored, sourceIdentity: { dev: stored.sourceIdentity.dev + 1, ino: stored.sourceIdentity.ino } }));
  const restarted = router();
  const live = await lstat(folder);
  assert.equal(await restarted.resume(project, taskId), folder);
  assert.deepEqual(await restarted.identity(project, taskId), { dev: live.dev, ino: live.ino });
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'first turn\n');
  assert.equal(await readFile(join(folder, 'pending.txt'), 'utf8'), 'pending edit\n');
});

for (const replacement of ['missing', 'foreign', 'symlink'] as const) {
  test(`folder resume rejects a ${replacement} folder without recreating or modifying it`, async t => {
    const { root, folder, project, router, taskId } = await folderFixture(t);
    await rename(folder, `${folder}-original`);
    if (replacement === 'foreign') {
      await mkdir(folder);
      await writeFile(join(folder, 'foreign.txt'), 'keep me');
    }
    if (replacement === 'symlink') await symlink(`${folder}-original`, folder);
    for (const workspace of [router(), router()]) {
      await assert.rejects(workspace.resume(project, taskId));
      await assert.rejects(workspace.identity(project, taskId));
    }
    if (replacement === 'foreign') {
      await assert.rejects(router().resume(project, taskId), { name: 'RunnerError', code: 'conflict' });
      assert.equal(await readFile(join(folder, 'foreign.txt'), 'utf8'), 'keep me');
    }
    if (replacement === 'missing') await assert.rejects(lstat(folder), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'folder-original', 'notes.txt'), 'utf8'), 'first turn\n');
  });
}

test('folder resume fails closed on a changed registration, a foreign or malformed record and a pre-aborted operation', async t => {
  const { root, folder, project, workspace, taskId, record } = await folderFixture(t);
  await assert.rejects(workspace.resume(project, taskId, AbortSignal.abort()), { name: 'AbortError' });
  const conflict = { name: 'RunnerError', code: 'conflict' };
  await assert.rejects(workspace.resume({ ...project, id: 'other' }, taskId), conflict);
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await assert.rejects(workspace.resume({ ...project, path: elsewhere }, taskId), conflict);
  const stored = JSON.parse(await readFile(record, 'utf8')) as Record<string, unknown>;
  const malformed: unknown[] = [{ ...stored, extra: true }, { ...stored, kind: 'repository' }, { ...stored, mode: 'worktree' }, { ...stored, version: 3 },
    { ...stored, source: 'folder' }, { ...stored, sourceIdentity: { dev: 1 } }, { ...stored, common: folder, commonIdentity: stored.sourceIdentity }, [], null, 'folder'];
  for (const value of malformed) {
    await writeFile(record, JSON.stringify(value));
    await assert.rejects(workspace.resume(project, taskId), conflict, JSON.stringify(value));
  }
  await writeFile(record, JSON.stringify(stored));
  assert.equal(await workspace.resume(project, taskId), folder);
  await rm(record);
  await assert.rejects(workspace.resume(project, taskId), conflict);
  await assert.rejects(workspace.identity(project, taskId), conflict);
});
