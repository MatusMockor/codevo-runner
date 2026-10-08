import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

const authorization = 'Bearer launch-effort-http-test';
const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-launch-http-'));
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
process.stdin.resume();
process.stdin.on('end', () => {
  const resume = process.argv.includes('resume');
  const expected = resume ? 'ultra' : 'high';
  if (!process.argv.includes('model_reasoning_effort="'+expected+'"')) process.exit(3);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '0194d46b-b92e-7000-8000-000000000001' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, {
    projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [new CliProviderExecutor('codex', { executable })],
  });
  app = await createRunnerApplication({ runnerId, name: 'Launch test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
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
  return { get, post, finished };
}

test('HTTP create/start/continue preserve selected Codex reasoning effort and legacy omission', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const options = { provider: 'codex', model: 'gpt-6.1-sol', mode: 'readOnly', effort: 'high' };
  const created = await f.post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex', launch: options, parts: [{ type: 'text', text: 'Say hello' }] });
  assert.equal(created.status, 201);
  const root = (await created.json()).task as Task;
  assert.deepEqual(root.launch, options);
  const start = await f.post(`/v1/tasks/${root.id}/start`, { projectId: 'sample' });
  assert.equal(start.status, 202);
  assert.deepEqual((await start.json()).launch, options);
  await f.finished(root.id);
  const request = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Continue' }], launch: { ...options, effort: 'ultra' } };
  const response = await f.post(`/v1/tasks/${root.id}/continue`, request);
  assert.equal(response.status, 202);
  const child = (await response.json()).task as Task;
  assert.deepEqual(child.launch, request.launch);
  await f.finished(child.id);
  const retry = await f.post(`/v1/tasks/${root.id}/continue`, request);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).task.id, child.id);
  for (const effort of [null, 'extreme', 'high\n', 1]) {
    const rejected = await f.post(`/v1/tasks/${child.id}/continue`, { ...request, idempotencyKey: randomUUID(), launch: { ...options, effort } });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'invalid_input' });
  }
  const legacy = { provider: 'codex', model: 'default', mode: 'default' };
  for (const launch of [legacy, { ...legacy, effort: 'default' }]) {
    const response = await f.post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex', launch, parts: [{ type: 'text', text: 'Legacy' }] });
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).task.launch, legacy);
  }
});

test('HTTP create echoes an omitted Claude context as omitted and an explicit one unchanged', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const omitted = { provider: 'claudeCode', model: 'claude-opus-5-5', mode: 'bypassPermissions', effort: 'high' };
  const request = { idempotencyKey: randomUUID(), provider: 'claude', launch: omitted, parts: [{ type: 'text', text: 'Say hello' }] };
  const created = await f.post('/v1/tasks', request);
  assert.equal(created.status, 201);
  const draft = (await created.json()).task as Task;
  assert.deepEqual(draft.launch, { ...omitted, fastMode: false, thinkingMode: false });
  const retried = await f.post('/v1/tasks', request);
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json()).task.launch, draft.launch);
  assert.deepEqual((await (await f.get(`/v1/tasks/${draft.id}`)).json()).launch, draft.launch);
  for (const context of ['200k', '1m']) {
    const explicit = await f.post('/v1/tasks', { ...request, idempotencyKey: randomUUID(), launch: { ...omitted, context } });
    assert.equal(explicit.status, 201);
    assert.equal((await explicit.json()).task.launch.context, context);
  }
});
