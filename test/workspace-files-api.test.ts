import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Task } from '../src/domain/contracts.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer workspace-files-http-test';
const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-files-http-'));
  let app: Awaited<ReturnType<typeof createRunnerApplication>> | undefined;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const executable = join(root, 'provider-fixture');
  // Substitute only the third-party CLI; HTTP, execution, persistence and Git are real.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const resume = process.argv.includes('resume');
  fs.writeFileSync('tracked.txt', resume ? 'first\\nsecond\\n' : 'first\\n');
  fs.writeFileSync('new.txt', 'new file\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '0194d46b-b92e-7000-8000-000000000001' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, {
    projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [new CliProviderExecutor('codex', { executable })],
  });
  app = await createRunnerApplication({ runnerId, name: 'Files test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  async function draft() {
    const response = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Edit files' }] });
    assert.equal(response.status, 201);
    return (await response.json()).task as Task;
  }
  async function finished(id: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const task = await (await get(`/v1/tasks/${id}`)).json() as Task;
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
        assert.equal(task.status, 'succeeded');
        return;
      }
      await delay(20);
    }
    assert.fail('Task did not finish');
  }
  async function launch() {
    const task = await draft();
    assert.equal((await post(`/v1/tasks/${task.id}/start`, { projectId: 'sample' })).status, 202);
    await finished(task.id);
    return task;
  }
  return { source, url, runnerId, get, post, draft, launch, finished };
}

test('HTTP file review returns original and modified contents across continuation on the same workspace', { timeout: 30_000 }, async t => {
  const { source, get, post, launch, finished } = await fixture(t);
  assert.equal((await (await get('/v1/runner')).json()).capabilities.taskFileDiffs, true);
  const first = await launch();
  const files = await get(`/v1/tasks/${first.id}/files`);
  assert.equal(files.status, 200);
  assert.deepEqual(await files.json(), { files: [
    { path: 'tracked.txt', status: 'modified' }, { path: 'new.txt', status: 'untracked' },
  ], truncated: false });
  const diff = await post(`/v1/tasks/${first.id}/file-diff`, { path: 'tracked.txt' });
  assert.equal(diff.status, 200);
  assert.deepEqual(await diff.json(), { path: 'tracked.txt', original: { text: 'original\n', truncated: false },
    modified: { text: 'first\n', truncated: false }, unavailableReason: null });
  assert.deepEqual(await (await post(`/v1/tasks/${first.id}/file-diff`, { path: 'new.txt' })).json(), {
    path: 'new.txt', original: { text: '', truncated: false }, modified: { text: 'new file\n', truncated: false }, unavailableReason: null,
  });
  const continued = await post(`/v1/tasks/${first.id}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Continue editing' }] });
  assert.equal(continued.status, 202);
  const second = (await continued.json()).task as Task;
  await finished(second.id);
  const current = await post(`/v1/tasks/${second.id}/file-diff`, { path: 'tracked.txt' });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { path: 'tracked.txt', original: { text: 'original\n', truncated: false },
    modified: { text: 'first\nsecond\n', truncated: false }, unavailableReason: null });
  assert.deepEqual(await (await get(`/v1/tasks/${second.id}/files`)).json(), await (await get(`/v1/tasks/${first.id}/files`)).json());
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'original\n');
});

test('HTTP file review rejects unknown fields, path escapes and missing task or workspace', { timeout: 30_000 }, async t => {
  const { get, post, draft, launch } = await fixture(t);
  const task = await launch();
  for (const body of [null, [], {}, { path: 'tracked.txt', cwd: '/tmp' }, { path: 1 },
    ...['../tracked.txt', '/etc/passwd', 'a/../../tracked.txt', '.git/config', 'a\\b', 'a\u0000b', 'C:/file'].map(path => ({ path }))]) {
    const response = await post(`/v1/tasks/${task.id}/file-diff`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_input' });
  }
  const missing = randomUUID();
  assert.equal((await get(`/v1/tasks/${missing}/files`)).status, 404);
  assert.equal((await post(`/v1/tasks/${missing}/file-diff`, { path: 'tracked.txt' })).status, 404);
  const pending = await draft();
  assert.equal((await get(`/v1/tasks/${pending.id}/files`)).status, 409);
  assert.equal((await post(`/v1/tasks/${pending.id}/file-diff`, { path: 'tracked.txt' })).status, 409);
});

test('HTTP file review enforces authentication, runner identity and closed methods', { timeout: 30_000 }, async t => {
  const { url, runnerId, launch } = await fixture(t);
  const task = await launch();
  for (const suffix of ['files', 'file-diff']) {
    const init = suffix === 'files' ? {} : { method: 'POST', body: JSON.stringify({ path: 'tracked.txt' }) };
    const endpoint = `${url}/v1/tasks/${task.id}/${suffix}`;
    assert.equal((await fetch(endpoint, { ...init, headers: { 'content-type': 'application/json' } })).status, 401);
    const mismatch = await fetch(endpoint, { ...init, headers: { authorization, 'content-type': 'application/json', 'x-codevo-runner-id': randomUUID() } });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: 'runner_identity_mismatch' });
    assert.equal((await fetch(endpoint, { ...init, headers: { authorization, 'content-type': 'application/json', 'x-codevo-runner-id': runnerId } })).status, 200);
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers: { authorization } })).status, 405);
  }
});
