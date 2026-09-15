import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionService } from '../src/application/execution-service.js';
import type { ExecutionRequest, ExecutionResult } from '../src/domain/execution.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const input = (text: string) => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text }] });
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await read()) return; await delay(5); }
  throw new Error('Pending lifecycle condition timed out');
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pending-lifecycle-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  const requests: ExecutionRequest[] = [];
  const finish: Array<(result: ExecutionResult) => void> = [];
  const project = { id: 'sample', name: 'Sample', path: directory };
  const sessionId = randomUUID();
  const service = new ExecutionService(repository, repository, {
    list: async () => [project], get: async () => project,
  }, {
    prepare: async () => directory, resume: async () => directory,
    diff: async () => { throw new Error('Not used'); },
    files: async () => { throw new Error('Not used'); },
    fileDiff: async () => { throw new Error('Not used'); },
  }, [{ provider: 'codex', supportsAttachments: false, execute: async request => {
    requests.push(request);
    await request.onSession?.(sessionId);
    return new Promise<ExecutionResult>(resolve => {
      finish.push(resolve);
      request.signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
      if (request.signal.aborted) resolve({ exitCode: null });
    });
  } }]);
  t.after(async () => { await service.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  await service.initialize();
  const root = (await repository.createTask({ ...input('Initial'), provider: 'codex' })).task;
  await service.start(root.id, { projectId: project.id });
  await until(async () => finish.length === 1);
  return { repository, service, root, requests, finish, sessionId };
}

test('detached worker drains pending messages in order after completion, retaining the provider session', async t => {
  const { repository, service, root, requests, finish, sessionId } = await fixture(t);
  const first = await service.enqueue(root.id, input('First'));
  const second = await service.enqueue(root.id, input('Second'));
  assert.equal(requests.length, 1);
  assert.equal((await service.pending(root.id)).items.filter(item => item.status === 'queued').length, 2);
  finish[0]!({ exitCode: 0 });
  await until(async () => finish.length === 2);
  assert.equal(requests[1]!.resumeSessionId, sessionId);
  assert.deepEqual(requests[1]!.task.parts, first.pending.parts);
  assert.equal(requests[1]!.task.parentTaskId, root.id);
  finish[1]!({ exitCode: 0 });
  await until(async () => finish.length === 3);
  assert.deepEqual(requests[2]!.task.parts, second.pending.parts);
  assert.equal(requests[2]!.task.parentTaskId, requests[1]!.task.id);
  finish[2]!({ exitCode: 0 });
  await until(async () => (await repository.getTask(requests[2]!.task.id)).status === 'succeeded');
  assert.equal(requests.length, 3);
});

test('Stop pauses followups and explicit resume admits one continuation after provider shutdown', async t => {
  const { repository, service, root, requests, finish } = await fixture(t);
  const queued = await service.enqueue(root.id, input('After stop'));
  await service.cancel(root.id);
  assert.equal(requests[0]!.signal.aborted, true);
  await until(async () => (await service.pending(root.id)).items.some(item => item.id === queued.pending.id && item.status === 'paused'));
  assert.equal(requests.length, 1);
  assert.equal((await repository.getTask(root.id)).status, 'cancelled');
  await service.resumePending(root.id);
  await until(async () => finish.length === 2);
  assert.equal(requests[1]!.task.parentTaskId, root.id);
  finish[1]!({ exitCode: 0 });
  await until(async () => (await repository.getTask(requests[1]!.task.id)).status === 'succeeded');
});
