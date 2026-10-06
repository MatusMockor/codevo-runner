import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ProviderExecutor } from '../src/application/execution-ports.js';
import { APPROVAL_LIMITS, type AgentApprovalInput, type AgentApprovalOutcome, type AgentApprovalRequest } from '../src/domain/approvals.js';
import type { Task } from '../src/domain/contracts.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer approval-http-test-token';
const capability = { 'x-codevo-client-capabilities': 'interactiveApprovals' };
const sessionId = '0194d46b-b92e-7000-8000-00000000a001';
const input: AgentApprovalInput = {
  kind: 'command', title: 'Run a command?', detail: 'npm test', detailTruncated: false,
  facts: [{ label: 'Tool', value: 'Bash' }, { label: 'Purpose', value: 'Run the test suite' }],
  decisions: ['allowOnce', 'deny'],
};

type Options = Readonly<{ seedPending?: boolean; provider?: 'normal' | 'withdraw-first' | 'leak-first' | 'codex-process'; execution?: boolean }>;

function getWithBody(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: 'GET', headers: { authorization, connection: 'close', 'content-type': 'application/json', 'content-length': '2' } }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    outgoing.on('error', reject);
    outgoing.end('{}');
  });
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail('Expected durable approval state did not settle');
}

async function fixture(t: TestContext, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-approval-http-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const runnerId = randomUUID();
  const exec = promisify(execFile);
  await mkdir(project);
  await exec('git', ['init', project]);
  await writeFile(join(project, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', project, 'add', '.']);
  await exec('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  let restored: AgentApprovalRequest | undefined;
  if (options.seedPending) {
    const repository = await openSqliteRepository(data, runnerId);
    const { task } = await repository.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'Approve before editing' }] });
    await repository.queueTask(task.id, 'sample', undefined, true);
    await repository.claimNextTask();
    restored = await repository.createApproval({ ...input, id: randomUUID(), taskId: task.id, provider: 'claudeCode', status: 'pending',
      expiresAt: new Date(Date.now() + APPROVAL_LIMITS.timeoutMs).toISOString() });
    await repository.close();
  }
  const announced = new Map<string, boolean>();
  const received: AgentApprovalOutcome[] = [];
  const rejected: unknown[] = [];
  let failFirst!: () => void;
  const firstFailure = new Promise<void>(resolve => { failFirst = resolve; });
  const provider: ProviderExecutor = {
    provider: 'claude', supportsAttachments: false,
    async execute(request) {
      const first = announced.size === 0;
      announced.set(request.task.id, request.onApproval !== undefined);
      const done = async () => {
        await request.onOutput('stdout', JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', is_error: false }) + '\n');
        return { exitCode: 0, sessionId };
      };
      if (!request.onApproval) return done();
      if ((options.provider === 'withdraw-first' || options.provider === 'leak-first') && first) {
        const withdrawal = new AbortController();
        void request.onApproval(input, withdrawal.signal).catch(error => { rejected.push(error); });
        await firstFailure;
        if (options.provider === 'withdraw-first') withdrawal.abort();
        return { exitCode: 1, error: 'Provider exited while awaiting approval' };
      }
      received.push(await request.onApproval(input, new AbortController().signal));
      return done();
    },
  };
  const exitPath = join(root, 'provider-exit');
  const executable = join(root, 'codex-provider');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const send = value => console.log(JSON.stringify(value));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: ${JSON.stringify(sessionId)} } } });
  if (frame.method !== 'turn/start') return;
  send({ id: frame.id, result: { turn: { id: 'turn-1' } } });
  send({ id: 88, method: 'item/commandExecution/requestApproval', params: { threadId: ${JSON.stringify(sessionId)}, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 1, command: 'npm test' } });
  setInterval(() => { if (fs.existsSync(${JSON.stringify(exitPath)})) process.exit(1); }, 20);
});
`, { mode: 0o700 });
  const agent = options.provider === 'codex-process' ? 'codex' : 'claude';
  const services = await openRunnerServices(data, runnerId, options.execution === false ? undefined : {
    projects: [{ id: 'sample', name: 'Sample project', path: project }],
    providers: [options.provider === 'codex-process' ? new CliProviderExecutor('codex', { executable, timeoutMs: 15_000 }) : provider],
  });
  const app = await createRunnerApplication({ runnerId, name: 'Approval HTTP test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method, headers: { authorization, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const message = (text: string) => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text', text }] });
  const create = async () => {
    const result = await request('/v1/tasks', 'POST', { ...message('Approve before editing'), provider: agent });
    assert.equal(result.status, 201);
    return (await result.json()).task.id as string;
  };
  const approvals = async (taskId: string): Promise<AgentApprovalRequest[]> => {
    const result = await request(`/v1/tasks/${taskId}/approvals`);
    assert.equal(result.status, 200);
    return (await result.json()).items;
  };
  const task = async (taskId: string, headers: Record<string, string> = {}): Promise<Task> => (await request(`/v1/tasks/${taskId}`, 'GET', undefined, headers)).json();
  const tasks = async (headers: Record<string, string> = {}): Promise<Task[]> => (await (await request('/v1/tasks', 'GET', undefined, headers)).json()).items;
  const status = async (taskId: string, expected: Task['status']) => eventually(async () => (await task(taskId)).status === expected);
  const pending = async (taskId: string) => {
    await eventually(async () => (await approvals(taskId)).some(item => item.status === 'pending'));
    return (await approvals(taskId)).find(item => item.status === 'pending')!;
  };
  const start = async (headers: Record<string, string> = capability) => {
    const id = await create();
    assert.equal((await request(`/v1/tasks/${id}/start`, 'POST', { projectId: 'sample' }, headers)).status, 202);
    return id;
  };
  const answer = (taskId: string, requestId: string, body: unknown) => request(`/v1/tasks/${taskId}/approvals/${requestId}/answer`, 'POST', body);
  const child = async (parentId: string) => {
    await eventually(async () => (await tasks()).some(item => item.parentTaskId === parentId));
    return (await tasks()).find(item => item.parentTaskId === parentId)!.id;
  };
  return { url, request, message, create, approvals, task, tasks, status, pending, start, answer, child, announced, received, rejected, restored, failFirst, exitProvider: () => writeFile(exitPath, 'exit') };
}

test('an announced task waits for a durable approval and one answer continues the exact invocation', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const id = await f.start();
  const pending = await f.pending(id);
  const { id: requestId, expiresAt, ...described } = pending;
  assert.deepEqual(described, { taskId: id, provider: 'claudeCode', ...input, status: 'pending' });
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.deepEqual(Object.keys(pending), ['id', 'taskId', 'provider', 'kind', 'title', 'detail', 'detailTruncated', 'facts', 'decisions', 'status', 'expiresAt']);
  await delay(80);
  const reconnected = await fetch(`${f.url}/v1/tasks/${id}/approvals`, { headers: { authorization, connection: 'close' } });
  assert.deepEqual((await reconnected.json()).items, [pending]);
  const announced = await f.task(id, capability);
  assert.equal(announced.status, 'running');
  assert.equal(announced.awaiting, 'approval');
  const legacy = await f.task(id);
  assert.equal(Object.hasOwn(legacy, 'awaiting'), false);
  const { awaiting: _awaiting, ...withoutAwaiting } = announced;
  assert.deepEqual(legacy, withoutAwaiting);
  assert.deepEqual((await f.tasks(capability)).map(item => item.awaiting), ['approval']);
  assert.ok((await f.tasks()).every(item => !Object.hasOwn(item, 'awaiting')));
  assert.deepEqual(f.received, []);
  const submitted = await f.answer(id, requestId, { decision: 'allowOnce' });
  assert.equal(submitted.status, 200);
  const settled = { ...pending, status: 'approved', decision: 'allowOnce' };
  assert.deepEqual(await submitted.json(), { request: settled });
  await f.status(id, 'succeeded');
  assert.deepEqual(f.received, ['allowOnce']);
  assert.deepEqual([...f.announced], [[id, true]]);
  const duplicate = await f.answer(id, requestId, { decision: 'allowOnce' });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { request: settled });
  const different = await f.answer(id, requestId, { decision: 'deny' });
  assert.equal(different.status, 409);
  assert.deepEqual(await different.json(), { error: 'conflict' });
  assert.deepEqual(f.received, ['allowOnce']);
  assert.deepEqual(await f.approvals(id), [settled]);
  assert.equal(Object.hasOwn(await f.task(id, capability), 'awaiting'), false);
});

test('an unannounced task runs without an approval callback and its task JSON is unchanged', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const id = await f.start({});
  await f.status(id, 'succeeded');
  assert.deepEqual([...f.announced], [[id, false]]);
  assert.deepEqual(f.received, []);
  assert.deepEqual(await f.approvals(id), []);
  const expected = ['id', 'runnerId', 'provider', 'status', 'parts', 'createdAt', 'projectId', 'sequence'];
  for (const headers of [{}, capability]) {
    assert.deepEqual(Object.keys(await f.task(id, headers)).sort(), [...expected].sort());
    assert.ok((await f.tasks(headers)).every(item => !Object.hasOwn(item, 'awaiting')));
  }
  const again = await f.request(`/v1/tasks/${id}/start`, 'POST', { projectId: 'sample' }, capability);
  assert.equal(again.status, 202);
  assert.equal(Object.hasOwn(await again.json(), 'awaiting'), false);
});

test('a continuation and a queued followup take the opt-in from their own admitting request', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const root = await f.start({});
  await f.status(root, 'succeeded');
  const continued = await f.request(`/v1/tasks/${root}/continue`, 'POST', f.message('Second turn'), capability);
  assert.equal(continued.status, 202);
  const second = (await continued.json()).task.id as string;
  const first = await f.pending(second);
  assert.equal((await f.request(`/v1/tasks/${second}/pending`, 'POST', f.message('Third turn'))).status, 202);
  assert.equal((await f.answer(second, first.id, { decision: 'deny' })).status, 200);
  await f.status(second, 'succeeded');
  const third = await f.child(second);
  await f.status(third, 'succeeded');
  assert.equal((await f.request(`/v1/tasks/${third}/pending`, 'POST', f.message('Fourth turn'), capability)).status, 202);
  const fourth = await f.child(third);
  const last = await f.pending(fourth);
  assert.equal((await f.answer(fourth, last.id, { decision: 'allowOnce' })).status, 200);
  await f.status(fourth, 'succeeded');
  assert.deepEqual([...f.announced], [[root, false], [second, true], [third, false], [fourth, true]]);
  assert.deepEqual(f.received, ['deny', 'allowOnce']);
  assert.deepEqual(await f.approvals(third), []);
});

test('approval routes enforce authentication, exact paths, the body limit and closed answers', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const id = await f.start();
  const pending = await f.pending(id);
  const foreign = await f.create();
  const path = `/v1/tasks/${id}/approvals/${pending.id}/answer`;
  const json = { 'content-type': 'application/json' };
  const post = (body: string, headers: Record<string, string> = json) => fetch(`${f.url}${path}`, { method: 'POST', headers: { authorization, connection: 'close', ...headers }, body });
  const padded = (bytes: number) => {
    const prefix = '{"decision":"allowOnce","pad":"';
    return `${prefix}${'x'.repeat(bytes - prefix.length - 2)}"}`;
  };
  assert.equal((await fetch(`${f.url}${path}`, { method: 'POST', headers: json, body: '{"decision":"allowOnce"}' })).status, 401);
  assert.equal((await fetch(`${f.url}/v1/tasks/${id}/approvals`)).status, 401);
  assert.equal((await post('{"decision":"allowOnce"}', { ...json, origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.request(`/v1/tasks/${id}/approvals`, 'GET', undefined, { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.request(path, 'GET')).status, 405);
  assert.equal((await f.request(`/v1/tasks/${id}/approvals`, 'POST', { decision: 'deny' })).status, 405);
  assert.equal((await f.request(`${path}?extra=1`, 'POST', { decision: 'allowOnce' })).status, 404);
  assert.equal((await f.request(`/v1/tasks/${id}/approvals?after=0`)).status, 404);
  assert.equal((await f.request(`/v1/tasks/${id}/approvals/not-a-uuid/answer`, 'POST', { decision: 'allowOnce' })).status, 404);
  const bodied = await getWithBody(`${f.url}/v1/tasks/${id}/approvals`);
  assert.equal(bodied.status, 400);
  assert.deepEqual(JSON.parse(bodied.body), { error: 'body_not_allowed' });
  assert.equal((await post('{"decision":"allowOnce"}', { 'content-type': 'text/plain' })).status, 415);
  const oversized = await post(padded(4097));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'too_large' });
  const largest = await post(padded(4096));
  assert.equal(largest.status, 400);
  assert.deepEqual(await largest.json(), { error: 'invalid_input' });
  for (const body of ['{"decision":', '{}', '{"decision":"allowOnce","taskId":"x"}', '{"decision":"allowAlways"}', '{"decision":"allowForSession"}', '{"decision":["allowOnce"]}', '"allowOnce"', '[]', 'null'])
    assert.equal((await post(body)).status, 400, body);
  const misdirected = await f.answer(foreign, pending.id, { decision: 'allowOnce' });
  assert.equal(misdirected.status, 404);
  assert.deepEqual(await misdirected.json(), { error: 'not_found' });
  assert.equal((await f.answer(id, randomUUID(), { decision: 'allowOnce' })).status, 404);
  assert.equal((await f.request(`/v1/tasks/${randomUUID()}/approvals`)).status, 404);
  assert.deepEqual(await f.approvals(foreign), []);
  assert.equal((await f.approvals(id))[0]?.status, 'pending');
  assert.deepEqual(f.received, []);
  assert.equal((await f.answer(id, pending.id, { decision: 'deny' })).status, 200);
  await f.status(id, 'succeeded');
  assert.deepEqual(f.received, ['deny']);
});

test('Stop cancels a pending approval and rejects an answer arriving afterward', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const id = await f.start();
  const pending = await f.pending(id);
  const stopped = await f.request(`/v1/tasks/${id}/cancel`, 'POST');
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, 'cancelled');
  assert.deepEqual(await f.approvals(id), [{ ...pending, status: 'cancelled' }]);
  assert.equal((await f.answer(id, pending.id, { decision: 'allowOnce' })).status, 409);
  assert.equal(Object.hasOwn(await f.task(id, capability), 'awaiting'), false);
  assert.deepEqual(f.received, []);
});

test('a real provider process that exits with a pending approval cancels it and rejects a late answer', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { provider: 'codex-process' });
  const id = await f.start();
  const pending = await f.pending(id);
  assert.deepEqual([pending.provider, pending.kind, pending.title, pending.detail], ['codex', 'command', 'Run a command?', 'npm test']);
  assert.equal((await f.task(id, capability)).awaiting, 'approval');
  await f.exitProvider();
  await f.status(id, 'failed');
  await eventually(async () => (await f.approvals(id))[0]?.status !== 'pending');
  assert.deepEqual(await f.approvals(id), [{ ...pending, status: 'cancelled' }]);
  assert.equal((await f.answer(id, pending.id, { decision: 'allowOnce' })).status, 409);
  assert.equal(Object.hasOwn(await f.task(id, capability), 'awaiting'), false);
});

test('task completion expires an approval that its executor left pending and frees the waiter', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { provider: 'leak-first' });
  const first = await f.start();
  const pending = await f.pending(first);
  f.failFirst();
  await f.status(first, 'failed');
  await eventually(async () => (await f.approvals(first))[0]?.status === 'expired' && f.rejected.length === 1);
  assert.equal((await f.answer(first, pending.id, { decision: 'allowOnce' })).status, 409);
});

test('an executor that withdraws its request on failure cancels the approval and frees the waiter', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { provider: 'withdraw-first' });
  const first = await f.start();
  const pending = await f.pending(first);
  assert.equal(f.rejected.length, 0);
  f.failFirst();
  await f.status(first, 'failed');
  await eventually(async () => (await f.approvals(first))[0]?.status === 'cancelled' && f.rejected.length === 1);
  assert.ok(f.rejected[0] instanceof Error);
  assert.equal((await f.answer(first, pending.id, { decision: 'allowOnce' })).status, 409);
  const next = await f.start();
  const later = await f.pending(next);
  assert.notEqual(later.id, pending.id);
  assert.equal((await f.answer(next, later.id, { decision: 'allowOnce' })).status, 200);
  await f.status(next, 'succeeded');
  assert.deepEqual(f.received, ['allowOnce']);
  assert.equal(f.rejected.length, 1);
});

test('runner restart expires a persisted pending approval that has no live process', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { seedPending: true });
  const pending = f.restored!;
  assert.equal((await f.task(pending.taskId, capability)).status, 'interrupted');
  assert.equal(Object.hasOwn(await f.task(pending.taskId, capability), 'awaiting'), false);
  assert.deepEqual(await f.approvals(pending.taskId), [{ ...pending, status: 'expired' }]);
  assert.equal((await f.answer(pending.taskId, pending.id, { decision: 'allowOnce' })).status, 409);
  assert.deepEqual([...f.announced], []);
});

test('discovery advertises interactive approvals only to clients that announce the capability', { timeout: 20_000 }, async t => {
  const enabled = await fixture(t);
  const legacy = (await (await enabled.request('/v1/runner')).json()).capabilities;
  assert.equal(Object.hasOwn(legacy, 'interactiveApprovals'), false);
  const modern = (await (await enabled.request('/v1/runner', 'GET', undefined, capability)).json()).capabilities;
  assert.deepEqual(modern, { ...legacy, interactiveApprovals: true });
  const other = (await (await enabled.request('/v1/runner', 'GET', undefined, { 'x-codevo-client-capabilities': 'turnChanges' })).json()).capabilities;
  assert.equal(Object.hasOwn(other, 'interactiveApprovals'), false);
  const disabled = await fixture(t, { execution: false });
  const withoutExecution = (await (await disabled.request('/v1/runner', 'GET', undefined, capability)).json()).capabilities;
  assert.equal(withoutExecution.interactiveApprovals, false);
  assert.equal((await disabled.request(`/v1/tasks/${randomUUID()}/approvals`)).status, 404);
});
