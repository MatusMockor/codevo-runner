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
import type { ProviderExecutor } from '../src/application/execution-ports.js';
import type { AgentQuestion, AgentQuestionRequest, AgentQuestionResponse } from '../src/domain/questions.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer question-http-test-token';
const question: AgentQuestion = {
  id: 'storage', header: 'Storage', prompt: 'Which database should we use?',
  options: [
    { id: 'sqlite', label: 'SQLite', description: 'Keep this runner self-contained.' },
    { id: 'postgres', label: 'PostgreSQL', description: 'Use a managed database.' },
  ],
  multiple: false, allowCustom: true,
};
const answer: AgentQuestionResponse = {
  answers: [{ questionId: 'storage', optionIds: ['sqlite'], text: 'Keep the existing data.' }],
};

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail('Expected durable question state did not settle');
}

async function fixture(t: TestContext, seedPending = false, providerBehavior: 'normal' | 'fail-first-question' = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'codevo-question-http-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const runnerId = randomUUID();
  const exec = promisify(execFile);
  await mkdir(project);
  await exec('git', ['init', project]);
  await writeFile(join(project, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', project, 'add', '.']);
  await exec('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  let restored: AgentQuestionRequest | undefined;
  if (seedPending) {
    // Persist exactly the state an abruptly terminated runner leaves behind.
    const repository = await openSqliteRepository(data, runnerId);
    try {
      const { task } = await repository.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'Ask before editing' }] });
      await repository.queueTask(task.id, 'sample');
      await repository.claimNextTask();
      restored = { id: randomUUID(), taskId: task.id, provider: 'claudeCode', questions: [question], status: 'pending' };
      await repository.createQuestion(restored);
    } finally { await repository.close(); }
  }
  const invocations: string[] = [];
  const received: AgentQuestionResponse[] = [];
  const rejected: unknown[] = [];
  let failFirst!: () => void;
  const firstFailure = new Promise<void>(resolve => { failFirst = resolve; });
  const provider: ProviderExecutor = {
    provider: 'claude', supportsAttachments: false,
    async execute(request) {
      invocations.push(request.task.id);
      assert.ok(request.onQuestion, 'Execution must expose the question callback');
      if (providerBehavior === 'fail-first-question' && invocations.length === 1) {
        // A provider may fail or time out while its independent question callback waits.
        void request.onQuestion([question]).catch(error => { rejected.push(error); });
        await firstFailure;
        return { exitCode: 1, error: 'Provider exited while awaiting input' };
      }
      const response = await request.onQuestion([question]);
      received.push(response);
      await request.onOutput('stdout', JSON.stringify({ type: 'result', subtype: 'success', result: 'Used the selected database', is_error: false }) + '\n');
      return { exitCode: 0 };
    },
  };
  const services = await openRunnerServices(data, runnerId, {
    projects: [{ id: 'sample', name: 'Sample project', path: project }], providers: [provider],
  });
  const app = await createRunnerApplication({ runnerId, name: 'Question HTTP test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  // Close each connection: neither execution nor its waiter belongs to a client socket.
  const request = (path: string, method = 'GET', input?: unknown) => fetch(`${url}${path}`, {
    method, headers: { authorization, connection: 'close', ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const create = async () => {
    const result = await request('/v1/tasks', 'POST', { idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'Ask before editing' }] });
    assert.equal(result.status, 201);
    return (await result.json()).task.id as string;
  };
  const questions = async (taskId: string): Promise<AgentQuestionRequest[]> => {
    const result = await request(`/v1/tasks/${taskId}/questions`);
    assert.equal(result.status, 200);
    return (await result.json()).items;
  };
  const start = async () => {
    const id = await create();
    assert.equal((await request(`/v1/tasks/${id}/start`, 'POST', { projectId: 'sample' })).status, 202);
    await eventually(async () => (await questions(id)).some(item => item.status === 'pending'));
    return { id, pending: (await questions(id))[0]! };
  };
  return { url, request, create, start, questions, invocations, received, restored, rejected, failFirst };
}

test('question survives disconnected clients and an answer continues the exact invocation once', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const { id, pending } = await f.start();
  assert.deepEqual(pending.questions, [question]);
  assert.equal(pending.provider, 'claudeCode');
  assert.equal((await (await f.request('/v1/runner')).json()).capabilities.interactiveQuestions, true);
  await delay(80);
  // A fresh HTTP client can discover the same question after the first client left.
  const reconnected = await fetch(`${f.url}/v1/tasks/${id}/questions`, { headers: { authorization, connection: 'close' } });
  assert.deepEqual((await reconnected.json()).items, [pending]);
  assert.equal((await (await f.request(`/v1/tasks/${id}`)).json()).status, 'running');
  assert.deepEqual(f.invocations, [id]);
  assert.deepEqual(f.received, []);
  const path = `/v1/tasks/${id}/questions/${pending.id}/answer`;
  const submitted = await f.request(path, 'POST', answer);
  assert.equal(submitted.status, 200);
  assert.deepEqual((await submitted.json()).request, { ...pending, status: 'answered', answers: answer.answers });
  await eventually(async () => (await (await f.request(`/v1/tasks/${id}`)).json()).status === 'succeeded');
  assert.deepEqual(f.received, [answer]);
  assert.deepEqual(f.invocations, [id]);
  // A client may lose the first response and retry only after execution completed.
  const duplicate = await f.request(path, 'POST', answer);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).request.status, 'answered');
  assert.equal((await f.request(path, 'POST', { answers: [{ questionId: 'storage', optionIds: ['postgres'], text: '' }] })).status, 409);
  assert.deepEqual(f.received, [answer]);
  assert.deepEqual((await f.questions(id))[0], { ...pending, status: 'answered', answers: answer.answers });
});

test('question answer routes reject foreign ownership, invalid membership and injected fields', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const { id, pending } = await f.start();
  const foreign = await f.create();
  const path = `/v1/tasks/${id}/questions/${pending.id}/answer`;
  assert.equal((await f.request(`/v1/tasks/${foreign}/questions/${pending.id}/answer`, 'POST', answer)).status, 404);
  assert.equal((await f.request(`/v1/tasks/${id}/questions/${randomUUID()}/answer`, 'POST', answer)).status, 404);
  assert.equal((await f.request(`/v1/tasks/${randomUUID()}/questions`)).status, 404);
  for (const input of [
    { ...answer, taskId: foreign },
    { response: answer },
    { answers: [{ ...answer.answers[0], extra: true }] },
    { answers: [{ questionId: 'foreign', optionIds: ['sqlite'], text: '' }] },
    { answers: [{ questionId: 'storage', optionIds: ['foreign'], text: '' }] },
    { answers: [{ questionId: 'storage', optionIds: ['sqlite', 'postgres'], text: '' }] },
    { answers: [] },
  ]) assert.equal((await f.request(path, 'POST', input)).status, 400);
  assert.equal((await fetch(`${f.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) })).status, 401);
  assert.equal((await f.request(`${path}?extra=1`, 'POST', answer)).status, 404);
  assert.equal((await f.request(path, 'GET')).status, 405);
  assert.equal((await f.questions(id))[0]!.status, 'pending');
  assert.deepEqual(f.received, []);
});

test('Stop cancels the durable question and rejects an answer arriving afterward', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const { id, pending } = await f.start();
  const stopped = await f.request(`/v1/tasks/${id}/cancel`, 'POST');
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, 'cancelled');
  await eventually(async () => (await f.questions(id))[0]!.status === 'cancelled');
  assert.equal((await f.request(`/v1/tasks/${id}/questions/${pending.id}/answer`, 'POST', answer)).status, 409);
  assert.deepEqual(f.received, []);
  assert.deepEqual(f.invocations, [id]);
});

test('runner restart expires persisted pending questions without inventing a resumable process', { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const pending = f.restored!;
  assert.equal((await (await f.request(`/v1/tasks/${pending.taskId}`)).json()).status, 'interrupted');
  assert.deepEqual(await f.questions(pending.taskId), [{ ...pending, status: 'expired' }]);
  assert.equal((await f.request(`/v1/tasks/${pending.taskId}/questions/${pending.id}/answer`, 'POST', answer)).status, 409);
  assert.deepEqual(f.invocations, []);
});


test('provider failure settles an outstanding question and releases its waiter for the next task', { timeout: 20_000 }, async t => {
  const f = await fixture(t, false, 'fail-first-question');
  const first = await f.start();
  assert.equal(f.rejected.length, 0);
  f.failFirst();
  await eventually(async () => (await (await f.request(`/v1/tasks/${first.id}`)).json()).status === 'failed');
  await eventually(async () => (await f.questions(first.id))[0]!.status === 'expired' && f.rejected.length === 1);
  assert.ok(f.rejected[0] instanceof Error, 'The provider callback must reject instead of remaining unresolved');
  assert.equal((await f.request(`/v1/tasks/${first.id}/questions/${first.pending.id}/answer`, 'POST', answer)).status, 409);
  const next = await f.start();
  assert.notEqual(next.pending.id, first.pending.id);
  assert.equal((await f.request(`/v1/tasks/${next.id}/questions/${next.pending.id}/answer`, 'POST', answer)).status, 200);
  await eventually(async () => (await (await f.request(`/v1/tasks/${next.id}`)).json()).status === 'succeeded');
  assert.deepEqual(f.invocations, [first.id, next.id]);
  assert.deepEqual(f.received, [answer]);
  assert.equal(f.rejected.length, 1);
});
