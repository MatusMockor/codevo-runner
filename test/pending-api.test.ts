import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer pending-http-test-token';
const exec = promisify(execFile);
async function fixture(t: TestContext, provider: 'codex' | 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'codevo-pending-http-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const executable = join(root, 'provider-fixture');
  const releasePath = join(root, 'release');
  // Replace only the provider executable; HTTP, SQLite, orchestration and Git are real.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const sessionId = '0194d46b-b92e-7000-8000-000000000001';
  const provider = ${JSON.stringify(provider)};
  const resumed = process.argv.includes(provider === 'codex' ? 'resume' : '--resume');
  if (resumed && !process.argv.includes(sessionId)) process.exit(11);
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  emit(provider === 'codex' ? { type: 'thread.started', thread_id: sessionId }
    : { type: 'system', subtype: 'init', session_id: sessionId });
  const timer = setInterval(() => {
    if (!resumed && !fs.existsSync(${JSON.stringify(releasePath)})) return;
    clearInterval(timer);
    emit(provider === 'codex' ? { type: 'turn.completed' }
      : { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'Done' });
  }, 20);
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, {
    projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [new CliProviderExecutor(provider, { executable })],
  });
  const app = await createRunnerApplication({ runnerId, name: 'Pending test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', input?: unknown) => fetch(`${url}${path}`, {
    method, headers: { authorization, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const create = async () => {
    const result = await request('/v1/tasks', 'POST', { idempotencyKey: randomUUID(), provider,
      parts: [{ type: 'text', text: 'First turn' }] });
    assert.equal(result.status, 201);
    return (await result.json()).task.id as string;
  };
  return { request, create, release: () => writeFile(releasePath, 'go') };
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Expected runner state did not settle');
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: pending HTTP messages wait, retain order and drain after the active turn`, { timeout: 20_000 }, async t => {
    const { request, create, release } = await fixture(t, provider);
    const first = await create();
    assert.equal((await request(`/v1/tasks/${first}/start`, 'POST', { projectId: 'sample' })).status, 202);
    await eventually(async () => (await (await request(`/v1/tasks/${first}`)).json()).status === 'running');
    const path = `/v1/tasks/${first}/pending`;
    const input = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Followup one' }] };
    const admitted = await request(path, 'POST', input);
    assert.equal(admitted.status, 202);
    const firstPending = (await admitted.json()).pending;
    assert.equal(firstPending.status, 'queued');
    assert.equal(firstPending.taskId, null);
    const repeated = await request(path, 'POST', input);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).pending.id, firstPending.id);
    const second = await request(path, 'POST', { ...input, idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Followup two' }] });
    assert.equal(second.status, 202);
    const secondPending = (await second.json()).pending;
    const foreign = await create();
    assert.equal((await request(`/v1/tasks/${foreign}/pending/${secondPending.id}`, 'DELETE')).status, 404);
    assert.deepEqual((await (await request(path)).json()).items.map((item: { id: string }) => item.id), [firstPending.id, secondPending.id]);
    assert.equal((await (await request(`/v1/tasks/${first}`)).json()).status, 'running');
    const removed = await request(`${path}/${secondPending.id}`, 'DELETE');
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).status, 'cancelled');
    await release();
    await eventually(async () => {
      const tasks = (await (await request('/v1/tasks')).json()).items as { parentTaskId?: string; status: string }[];
      return tasks.some(task => task.parentTaskId === first && task.status === 'succeeded');
    });
    const tasks = (await (await request('/v1/tasks')).json()).items as { parentTaskId?: string }[];
    assert.equal(tasks.filter(task => task.parentTaskId === first).length, 1);
  });
}

test('pending HTTP routes reject injected fields and bodies on bodyless operations', { timeout: 20_000 }, async t => {
  const { request, create } = await fixture(t, 'codex');
  const first = await create();
  const path = `/v1/tasks/${first}/pending`;
  const input = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Queued message' }] };
  for (const injected of [{ provider: 'claude' }, { sessionId: randomUUID() }, { projectId: 'foreign' }, { cwd: '/tmp' }]) {
    assert.equal((await request(path, 'POST', { ...input, ...injected })).status, 400);
  }
  assert.equal((await request(`${path}/resume`, 'POST', {})).status, 400);
  assert.equal((await request(`${path}/${randomUUID()}`, 'DELETE', {})).status, 400);
  assert.equal((await request(path, 'PUT', input)).status, 405);
  assert.equal((await request(`${path}?extra=true`)).status, 404);
});
