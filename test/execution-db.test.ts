import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { EXECUTION_LIMITS } from '../src/domain/execution.js';
const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const, parts: [{ type: 'text' as const, text: 'Implement this' }] });

test('queue admission is durable and idempotent; interrupted work is never automatically rerun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const first = (await repository.createTask(input())).task;
    const second = (await repository.createTask(input())).task;
    const draft = (await repository.createTask(input())).task;
    const queued = await repository.queueTask(first.id, 'project');
    assert.deepEqual(await repository.queueTask(first.id, 'project'), queued);
    await assert.rejects(repository.queueTask(first.id, 'different'), { code: 'conflict' });
    await repository.queueTask(second.id, 'project');
    assert.equal((await repository.claimNextTask())!.id, first.id);
    await repository.close();
    repository = await openSqliteRepository(directory, runnerId);
    await repository.interruptRunningTasks();
    await repository.interruptRunningTasks();
    assert.equal((await repository.getTask(first.id)).status, 'interrupted');
    assert.equal((await repository.getTask(draft.id)).status, 'draft');
    assert.equal((await repository.queueTask(first.id, 'project')).status, 'interrupted');
    const claims = await Promise.all([repository.claimNextTask(), repository.claimNextTask()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean)!.id, second.id);
    assert.deepEqual((await repository.listEvents(first.id, 0)).items.map(event => event.type), ['task.created', 'task.queued', 'task.running', 'task.interrupted']);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancellation and completion races preserve the first terminal state and atomic events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const first = (await repository.createTask(input())).task;
    await repository.queueTask(first.id, 'project');
    await repository.claimNextTask();
    await repository.cancelTask(first.id);
    await repository.finishTask(first.id, { exitCode: 0 });
    await repository.appendTaskOutput(first.id, 'stdout', 'late');
    assert.equal((await repository.getTask(first.id)).status, 'cancelled');
    assert.deepEqual((await repository.listEvents(first.id, 0)).items.map(event => event.type), ['task.created', 'task.queued', 'task.running', 'task.cancelled']);
    const second = (await repository.createTask(input())).task;
    await repository.queueTask(second.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(second.id, { exitCode: 0 });
    assert.equal((await repository.cancelTask(second.id)).status, 'succeeded');
    const queued = (await repository.createTask(input())).task;
    await repository.queueTask(queued.id, 'project');
    await repository.cancelTask(queued.id);
    assert.equal(await repository.claimNextTask(), null);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('output is UTF-8 safe and bounded across reopen without sacrificing completion events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const task = (await repository.createTask(input())).task;
    await repository.queueTask(task.id, 'project');
    await repository.claimNextTask();
    await assert.rejects(repository.appendTaskOutput(task.id, 'stderr', '€'.repeat(5000)), { code: 'quota_exceeded' });
    await repository.appendTaskOutput(task.id, 'stderr', '€'.repeat(2730) + 'xx');
    for (let index = 0; index < EXECUTION_LIMITS.outputBytes / EXECUTION_LIMITS.outputEventBytes - 1; index++) {
      await repository.appendTaskOutput(task.id, 'stdout', 'x'.repeat(EXECUTION_LIMITS.outputEventBytes));
    }
    await repository.close();
    repository = await openSqliteRepository(directory, runnerId);
    await assert.rejects(repository.appendTaskOutput(task.id, 'stdout', 'must not exceed cap'), { code: 'quota_exceeded' });
    await repository.finishTask(task.id, { exitCode: 1, error: 'failed' });
    let cursor = 0;
    let total = 0;
    const types: string[] = [];
    for (;;) {
      const page = await repository.listEvents(task.id, cursor);
      for (const event of page.items) {
        types.push(event.type);
        if (event.text) {
          assert.ok(Buffer.byteLength(event.text) <= EXECUTION_LIMITS.outputEventBytes);
          assert.ok(!event.text.includes('\ufffd'));
          total += Buffer.byteLength(event.text);
        }
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(total, EXECUTION_LIMITS.outputBytes);
    assert.equal(types.at(-1), 'task.failed');
    assert.equal((await repository.getTask(task.id)).status, 'failed');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema v1 migration preserves original draft payload and events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const task = (await repository.createTask(input())).task;
    await repository.close();
    const db = new DatabaseSync(join(directory, 'runner.sqlite'));
    db.exec('DROP TABLE task_execution; ALTER TABLE events DROP COLUMN data; PRAGMA user_version=1');
    db.close();
    repository = await openSqliteRepository(directory, runnerId);
    assert.deepEqual(await repository.getTask(task.id), task);
    assert.equal((await repository.listEvents(task.id, 0)).items[0]!.type, 'task.created');
    assert.equal((await repository.queueTask(task.id, 'project')).status, 'queued');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('tiny output events cannot grow history beyond its event quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const task = (await repository.createTask(input())).task;
    await repository.queueTask(task.id, 'project');
    await repository.claimNextTask();
    for (let index = 0; index < EXECUTION_LIMITS.outputEvents; index++) await repository.appendTaskOutput(task.id, 'stdout', 'x');
    await assert.rejects(repository.appendTaskOutput(task.id, 'stdout', 'x'), { code: 'quota_exceeded' });
    await repository.finishTask(task.id, { exitCode: 0 });
    let cursor = 0;
    let count = 0;
    for (;;) {
      const page = await repository.listEvents(task.id, cursor);
      count += page.items.filter(event => event.type === 'task.output').length;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(count, EXECUTION_LIMITS.outputEvents);
    assert.equal((await repository.getTask(task.id)).status, 'succeeded');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('global output quota survives reopening and preserves terminal writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    for (let index = 0; index < 8; index++) {
      const task = (await repository.createTask(input())).task;
      await repository.queueTask(task.id, 'project');
      await repository.claimNextTask();
      for (let chunk = 0; chunk < EXECUTION_LIMITS.outputBytes / EXECUTION_LIMITS.outputEventBytes; chunk++) await repository.appendTaskOutput(task.id, 'stdout', 'x'.repeat(EXECUTION_LIMITS.outputEventBytes));
      assert.equal((await repository.finishTask(task.id, { exitCode: 0 })).status, 'succeeded');
    }
    await repository.close();
    repository = await openSqliteRepository(directory, runnerId);
    const task = (await repository.createTask(input())).task;
    await repository.queueTask(task.id, 'project');
    await repository.claimNextTask();
    await assert.rejects(repository.appendTaskOutput(task.id, 'stdout', 'beyond global budget'), { code: 'quota_exceeded' });
    assert.equal((await repository.listEvents(task.id, 0)).items.filter(event => event.type === 'task.output').length, 0);
    assert.equal((await repository.finishTask(task.id, { exitCode: 1, error: 'bounded failure' })).status, 'failed');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('bulk database quota reserves capacity for admitted task completion and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-execution-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  const ids: string[] = [];
  try {
    const active = (await repository.createTask(input())).task;
    await repository.queueTask(active.id, 'project');
    await repository.claimNextTask();
    await assert.rejects(async () => {
      for (let index = 0; index < 1000; index++) {
        const task = (await repository.createTask({ ...input(), parts: [{ type: 'text', text: 'x'.repeat(48_000) }] })).task;
        ids.push(task.id);
      }
    }, { code: 'quota_exceeded' });
    assert.ok(ids.length > 100 && ids.length < 1000);
    for (const id of ids) assert.equal((await repository.cancelTask(id)).status, 'cancelled');
    assert.equal((await repository.finishTask(active.id, { exitCode: 1, error: '\u0000'.repeat(8192) })).status, 'failed');
    const events = await repository.listEvents(active.id, 0);
    assert.equal(Buffer.byteLength(events.items.at(-1)!.error!), 1024);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
