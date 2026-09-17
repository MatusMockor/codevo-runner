import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openRunnerServices } from '../src/runtime.js';

const exec = promisify(execFile);
test('in-place execution and continued turns preserve checkout edits and source-backed review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-direct-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  await writeFile(join(source, 'tracked.txt'), 'user dirty\n');
  await writeFile(join(source, 'untracked.txt'), 'user file');
  let calls = 0;
  const sessionId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), randomUUID(), {
    projects: [{ id: 'project', name: 'Project', path: source }],
    providers: [{ provider: 'claude', supportsAttachments: false, execute: async request => {
      calls++;
      assert.equal(request.cwd, await realpath(source));
      assert.ok(request.cwdIdentity);
      assert.equal(request.task.isolation, 'in-place');
      assert.equal(await readFile(join(request.cwd, 'tracked.txt'), 'utf8'), 'user dirty\n');
      assert.equal(await readFile(join(request.cwd, 'untracked.txt'), 'utf8'), 'user file');
      await writeFile(join(request.cwd, 'preview.html'), '<!doctype html><p>Source preview</p>');
      return { exitCode: 0, sessionId };
    } }],
  });
  t.after(async () => { await services.close(); await rm(root, { recursive: true, force: true }); });
  const message = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Work' }] });
  const task = (await services.tasks.create({ ...message(), provider: 'claude', isolation: 'in-place' })).task;
  await services.execution!.start(task.id, { projectId: 'project' });
  async function finished(id: string) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await services.tasks.get(id);
      if (!['queued', 'running'].includes(current.status)) { assert.equal(current.status, 'succeeded'); return; }
      await delay(20);
    }
    assert.fail('Task did not finish');
  }
  await finished(task.id);
  const next = await services.execution!.continue(task.id, message());
  await finished(next.task.id);
  assert.equal(calls, 2);
  assert.match((await services.execution!.diff(next.task.id)).patch, /user dirty/);
  const files = await services.execution!.files(next.task.id);
  assert.ok(JSON.stringify(files).includes('untracked.txt'));
});
