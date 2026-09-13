import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
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

const authorization = 'Bearer resume-http-test-token';
const exec = promisify(execFile);
async function fixture(t: TestContext, provider: 'codex' | 'claude', pauseInitial = false) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-resume-http-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const executable = join(root, 'provider-fixture');
  const sessionId = '0194d46b-b92e-7000-8000-000000000001';
  // Only the third-party CLI boundary is substituted; HTTP, SQLite, orchestration,
  // process execution and Git workspaces are the real production components.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const provider = ${JSON.stringify(provider)};
  const sessionId = ${JSON.stringify(sessionId)};
  const resume = process.argv.includes(provider === 'codex' ? 'resume' : '--resume');
  if (resume && !process.argv.includes(sessionId)) process.exit(11);
  if (resume && fs.readFileSync('tracked.txt', 'utf8') !== 'first turn\\n') process.exit(12);
  if (!resume && fs.readFileSync('tracked.txt', 'utf8') !== 'original\\n') process.exit(13);
  fs.writeFileSync('tracked.txt', resume ? 'first turn\\nsecond turn\\n' : 'first turn\\n');
  fs.appendFileSync('turns.jsonl', JSON.stringify({ cwd: process.cwd(), resume, input }) + '\\n');
  const events = provider === 'codex'
    ? [{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.completed' }]
    : [{ type: 'system', subtype: 'init', session_id: sessionId }, { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'Done' }];
  if (${JSON.stringify(pauseInitial)} && !resume) {
    process.stdout.write(JSON.stringify(events[0]) + '\\n' + '{\"partial\":');
    setInterval(() => {}, 1000);
    return;
  }
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  const data = join(root, 'data');
  let app: Awaited<ReturnType<typeof createRunnerApplication>> | undefined;
  let url = '';
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    const services = await openRunnerServices(data, runnerId, {
      projects: [{ id: 'sample', name: 'Sample', path: source }],
      providers: [new CliProviderExecutor(provider, { executable })],
    });
    app = await createRunnerApplication({ runnerId, name: 'Resume test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }
  await start();
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const post = (path: string, input: unknown) => fetch(`${url}${path}`, { method: 'POST',
    headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  async function finished(id: string): Promise<Task> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const task = await (await get(`/v1/tasks/${id}`)).json() as Task;
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
      await delay(20);
    }
    throw new Error('Task did not finish');
  }
  return { data, source, get, post, finished, restart: async () => { await app!.close(); app = undefined; await start(); } };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: HTTP continuation survives service restart, preserves cwd and is idempotent`, { timeout: 20_000 }, async t => {
    const { data, source, get, post, finished, restart } = await fixture(t, provider);
    const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider,
      parts: [{ type: 'text', text: 'First turn' }] });
    assert.equal(created.status, 201);
    const first = (await created.json()).task as Task;
    assert.deepEqual(await (await get(`/v1/tasks/${first.id}/resume`)).json(), { available: false, reason: 'task_not_finished' });
    assert.equal((await post(`/v1/tasks/${first.id}/start`, { projectId: 'sample' })).status, 202);
    assert.equal((await finished(first.id)).status, 'succeeded');
    await restart();
    assert.deepEqual(await (await get(`/v1/tasks/${first.id}/resume`)).json(), { available: true, reason: null });
    const body = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Second turn' }] };
    const response = await post(`/v1/tasks/${first.id}/continue`, body);
    assert.equal(response.status, 202);
    const result = await response.json() as { task: Task & { parentTaskId: string; conversationId: string }; created: boolean };
    assert.equal(result.created, true);
    assert.equal(result.task.parentTaskId, first.id);
    assert.equal(result.task.conversationId, first.id);
    assert.equal((await finished(result.task.id)).status, 'succeeded');
    const retry = await post(`/v1/tasks/${first.id}/continue`, body);
    assert.equal(retry.status, 200);
    const repeated = await retry.json();
    assert.equal(repeated.created, false);
    assert.equal(repeated.task.id, result.task.id);
    assert.deepEqual(await (await get(`/v1/tasks/${first.id}/resume`)).json(), { available: false, reason: 'newer_turn_exists' });
    assert.equal((await post(`/v1/tasks/${first.id}/continue`, { ...body, idempotencyKey: randomUUID() })).status, 409);
    const cwd = join(data, 'workspaces', first.id);
    assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'first turn\nsecond turn\n');
    const turns = (await readFile(join(cwd, 'turns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(turns.length, 2);
    assert.equal(turns[0].cwd, turns[1].cwd);
    assert.deepEqual(turns.map(turn => turn.resume), [false, true]);
    assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'original\n');
    assert.match((await (await get(`/v1/tasks/${result.task.id}/diff`)).json()).patch, /second turn/);
    assert.deepEqual(await (await get(`/v1/tasks/${result.task.id}/resume`)).json(), { available: true, reason: null });
  });
}

test('continuation rejects injected authority and admits only one concurrent child', { timeout: 20_000 }, async t => {
  const { get, post, finished } = await fixture(t, 'codex');
  const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'First turn' }] });
  const first = (await created.json()).task as Task;
  assert.equal((await post(`/v1/tasks/${first.id}/start`, { projectId: 'sample' })).status, 202);
  assert.equal((await finished(first.id)).status, 'succeeded');
  const body = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Next turn' }] };
  for (const injected of [{ provider: 'claude' }, { sessionId: randomUUID() }, { projectId: 'foreign' }, { cwd: '/tmp' }]) {
    assert.equal((await post(`/v1/tasks/${first.id}/continue`, { ...body, ...injected })).status, 400);
  }
  const responses = await Promise.all([post(`/v1/tasks/${first.id}/continue`, body),
    post(`/v1/tasks/${first.id}/continue`, { ...body, idempotencyKey: randomUUID() })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const winner = await responses.find(response => response.status === 202)!.json();
  assert.equal((await finished(winner.task.id)).status, 'succeeded');
  const tasks = await (await get('/v1/tasks')).json();
  assert.equal(tasks.items.length, 2);
});

test('shutdown after provider init preserves session before terminal result and resumes dirty worktree', { timeout: 20_000 }, async t => {
  const { data, get, post, finished, restart } = await fixture(t, 'codex', true);
  const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'First turn' }] });
  const first = (await created.json()).task as Task;
  assert.equal((await post(`/v1/tasks/${first.id}/start`, { projectId: 'sample' })).status, 202);
  let initialized = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const events = await (await get(`/v1/tasks/${first.id}/events`)).json();
    if (JSON.stringify(events).includes('thread.started')) { initialized = true; break; }
    await delay(20);
  }
  assert.equal(initialized, true, 'Provider must emit init before service shutdown');
  await restart();
  assert.equal((await finished(first.id)).status, 'interrupted');
  assert.deepEqual(await (await get(`/v1/tasks/${first.id}/resume`)).json(), { available: true, reason: null });
  const resumed = await post(`/v1/tasks/${first.id}/continue`, { idempotencyKey: randomUUID(),
    parts: [{ type: 'text', text: 'Continue interrupted turn' }] });
  assert.equal(resumed.status, 202);
  const next = (await resumed.json()).task as Task;
  assert.equal((await finished(next.id)).status, 'succeeded');
  assert.equal(await readFile(join(data, 'workspaces', first.id, 'tracked.txt'), 'utf8'), 'first turn\nsecond turn\n');
});


test('committed continuation retry returns the existing turn when its worktree is temporarily unavailable', { timeout: 20_000 }, async t => {
  const { data, post, finished } = await fixture(t, 'codex');
  const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'First turn' }] });
  const first = (await created.json()).task as Task;
  assert.equal((await post(`/v1/tasks/${first.id}/start`, { projectId: 'sample' })).status, 202);
  assert.equal((await finished(first.id)).status, 'succeeded');
  const body = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Second turn' }] };
  const continued = await post(`/v1/tasks/${first.id}/continue`, body);
  assert.equal(continued.status, 202);
  const next = (await continued.json()).task as Task;
  assert.equal((await finished(next.id)).status, 'succeeded');
  const cwd = join(data, 'workspaces', first.id);
  const moved = `${cwd}-temporarily-unavailable`;
  await rename(cwd, moved);
  try {
    const retry = await post(`/v1/tasks/${first.id}/continue`, body);
    assert.equal(retry.status, 200);
    const result = await retry.json();
    assert.equal(result.created, false);
    assert.equal(result.task.id, next.id);
    assert.equal(result.task.status, 'succeeded');
    assert.equal((await post(`/v1/tasks/${first.id}/continue`, {
      ...body, parts: [{ type: 'text', text: 'Changed intent' }],
    })).status, 409);
  } finally {
    await rename(moved, cwd);
  }
});
