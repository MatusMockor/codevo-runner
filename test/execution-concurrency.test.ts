import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ExecutionService } from '../src/application/execution-service.js';
import { EXECUTION_LIMITS, type ExecutionRequest, type ExecutionResult } from '../src/domain/execution.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { FileInstructionWorkspace } from '../src/infrastructure/files/instruction-workspace.js';

const input = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Work' }] });
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await read()) return; await delay(10); }
  throw new Error('Concurrent execution condition timed out');
}
async function fixture(t: TestContext, concurrency = 2) {
  const root = await mkdtemp(join(tmpdir(), 'execution-concurrency-'));
  const projects = [];
  for (const id of ['one', 'two']) {
    const path = join(root, id); await mkdir(path);
    await promisify(execFile)('git', ['init', path]);
    await writeFile(join(path, 'README.md'), 'Initial');
    await promisify(execFile)('git', ['-C', path, 'add', '.']);
    await promisify(execFile)('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
    projects.push({ id, name: id, path });
  }
  const data = join(root, 'data');
  const repository = await openSqliteRepository(data, randomUUID());
  const requests = new Map<string, ExecutionRequest>();
  const finish = new Map<string, (result: ExecutionResult) => void>();
  const fail = new Map<string, (error: Error) => void>();
  const service = new ExecutionService(repository, repository, new ConfiguredProjectRegistry(projects), new GitProjectWorkspace(data), [{
    provider: 'codex', supportsAttachments: false,
    async execute(request) {
      await request.onSession?.(request.resumeSessionId ?? randomUUID());
      requests.set(request.task.id, request);
      return new Promise<ExecutionResult>((resolve, reject) => {
        finish.set(request.task.id, resolve); fail.set(request.task.id, reject);
        request.signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
        if (request.signal.aborted) resolve({ exitCode: null });
      });
    },
  }], undefined, undefined, new FileInstructionWorkspace(data), undefined, undefined, concurrency);
  t.after(async () => { await service.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  await service.initialize();
  const start = async (projectId = 'one') => {
    const task = (await repository.createTask({ ...input(), provider: 'codex', isolation: 'in-place' })).task;
    await service.start(task.id, { projectId }); return task;
  };
  return { repository, service, requests, finish, fail, start };
}

test('same checkout tasks overlap, capacity is global across projects, cancellation frees only its own slot', async t => {
  const { repository, service, requests, finish, start } = await fixture(t);
  assert.equal(EXECUTION_LIMITS.activeTasks, 64);
  const first = await start(); const second = await start(); const third = await start('two');
  await until(async () => requests.size === 2);
  assert.equal(requests.get(first.id)!.cwd, requests.get(second.id)!.cwd);
  assert.equal((await repository.getTask(third.id)).status, 'queued');
  await service.cancel(first.id);
  await until(async () => requests.has(third.id));
  assert.equal(requests.get(first.id)!.signal.aborted, true);
  assert.equal(requests.get(second.id)!.signal.aborted, false);
  finish.get(second.id)!({ exitCode: 0 }); finish.get(third.id)!({ exitCode: 0 });
  await until(async () => (await repository.getTask(third.id)).status === 'succeeded');
  assert.equal((await repository.getTask(first.id)).status, 'cancelled');
});

test('close aborts and reaps all workers while leaving queued work unstarted and fencing admission', async t => {
  const { repository, service, requests, start } = await fixture(t);
  const first = await start(); const second = await start('two'); const third = await start();
  await until(async () => requests.size === 2);
  await Promise.all([service.close(), service.close()]);
  assert.ok([...requests.values()].every(request => request.signal.aborted));
  assert.equal((await repository.getTask(first.id)).status, 'interrupted');
  assert.equal((await repository.getTask(second.id)).status, 'interrupted');
  assert.equal((await repository.getTask(third.id)).status, 'queued');
  await assert.rejects(service.start(third.id, { projectId: 'one' }), { code: 'busy' });
});

test('a failed provider releases capacity without cancelling another task or losing pending continuation order', async t => {
  const { repository, service, requests, finish, fail, start } = await fixture(t);
  const first = await start(); const second = await start('two');
  await until(async () => requests.size === 2);
  await service.enqueue(second.id, input()); await service.enqueue(second.id, input());
  fail.get(first.id)!(new Error('External provider failure'));
  await until(async () => (await repository.getTask(first.id)).status === 'failed');
  assert.equal(requests.get(second.id)!.signal.aborted, false);
  finish.get(second.id)!({ exitCode: 0 });
  await until(async () => requests.size === 3);
  const continuation = [...requests.values()].find(request => request.task.parentTaskId === second.id)!;
  assert.ok(continuation.resumeSessionId);
  finish.get(continuation.task.id)!({ exitCode: 0 });
  await until(async () => requests.size === 4);
  const last = [...requests.values()].find(request => request.task.parentTaskId === continuation.task.id)!;
  assert.ok(last);
  finish.get(last.task.id)!({ exitCode: 0 });
  await until(async () => (await repository.getTask(last.task.id)).status === 'succeeded');
});

test('a continuation waits for its predecessor steering cleanup while another conversation keeps running', async t => {
  const { repository, service, requests, finish, start } = await fixture(t, 3);
  const first = await start(); const other = await start('two');
  await until(async () => requests.size === 2);
  let release!: () => void;
  let delivering = false;
  const delivered = new Promise<void>(resolve => { release = resolve; });
  try {
    requests.get(first.id)!.onSteeringReady?.(async () => { delivering = true; await delivered; });
    const steering = service.steer(first.id, input());
    await until(async () => delivering);
    await service.enqueue(first.id, input());
    finish.get(first.id)!({ exitCode: 0 });
    await until(async () => (await repository.getTask(first.id)).status === 'succeeded');
    // Trigger admission while first is terminal but its cleanup is deliberately held.
    await service.resumePending(first.id);
    await until(async () => (await repository.listTasks(0)).items.some(task => task.parentTaskId === first.id && task.status === 'running'));
    const third = await start('two');
    assert.equal((await repository.getTask(third.id)).status, 'queued');
    assert.equal([...requests.values()].some(request => request.task.parentTaskId === first.id), false);
    assert.equal(requests.get(other.id)!.signal.aborted, false);
    release(); await steering;
    await until(async () => [...requests.values()].some(request => request.task.parentTaskId === first.id));
  } finally { release(); }
});
