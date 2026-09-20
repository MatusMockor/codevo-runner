import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS, RunnerError, type Task } from '../src/domain/contracts.js';
import { PendingDatabase, PENDING_SCHEMA } from '../src/infrastructure/sqlite/pending-database.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const input = (text = 'Follow up') => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text }] });
async function fixture(t: TestContext, changed: () => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pending-db-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity, changed);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { identity, get repository() { return repository; }, async reopen() {
    await repository.close();
    repository = await openSqliteRepository(directory, identity, changed);
    return repository;
  } };
}
async function active(repository: Awaited<ReturnType<typeof openSqliteRepository>>) {
  const root = (await repository.createTask({ ...input('Initial'), provider: 'codex' })).task;
  await repository.queueTask(root.id, 'project');
  assert.equal((await repository.claimNextTask())?.id, root.id);
  return root;
}

test('pending admission preserves session capture and promotes FIFO only after each turn succeeds', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  const first = await repository.enqueuePending(root.id, input('First'));
  const second = await repository.enqueuePending(root.id, input('Second'));
  assert.equal(first.created, true);
  assert.equal(first.pending.status, 'queued');
  assert.equal(first.pending.taskId, null);
  assert.equal(first.pending.conversationId, root.id);
  assert.equal(await repository.promotePending(), null);
  const sessionId = randomUUID();
  await repository.setTaskSession(root.id, sessionId);
  assert.equal((await repository.getTaskSession(root.id)).sessionId, sessionId);
  await repository.finishTask(root.id, { exitCode: 0 });
  const child = await repository.promotePending();
  assert.ok(child);
  assert.equal(child.parentTaskId, root.id);
  assert.deepEqual(child.parts, first.pending.parts);
  assert.deepEqual(await repository.getTaskSession(child.id), { sessionId, workspaceTaskId: root.id });
  assert.equal(await repository.promotePending(), null);
  await repository.claimNextTask();
  assert.equal(await repository.promotePending(), null);
  await repository.finishTask(child.id, { exitCode: 0 });
  const next = await repository.promotePending();
  assert.ok(next);
  assert.equal(next.parentTaskId, child.id);
  assert.deepEqual(next.parts, second.pending.parts);
  assert.equal(await repository.promotePending(), null);
});

test('pending idempotency survives dispatch and reopening without duplicating a turn', async t => {
  const state = await fixture(t);
  let repository = state.repository;
  const root = await active(repository);
  const request = input();
  const first = await repository.enqueuePending(root.id, request);
  assert.deepEqual(await repository.enqueuePending(root.id, request), { pending: first.pending, created: false });
  await assert.rejects(repository.enqueuePending(root.id, { ...request, parts: input('Changed').parts }), { code: 'conflict' });
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  const child = await repository.promotePending();
  assert.ok(child);
  repository = await state.reopen();
  const retried = await repository.enqueuePending(root.id, request);
  assert.equal(retried.created, false);
  assert.equal(retried.pending.id, first.pending.id);
  assert.equal(retried.pending.taskId, child.id);
  assert.equal(retried.pending.status, 'dispatched');
  assert.equal(await repository.promotePending(), null);
});

test('removal is owner scoped, idempotent and cannot cancel a dispatched task', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  const foreign = (await repository.createTask({ ...input(), provider: 'claude' })).task;
  const first = (await repository.enqueuePending(root.id, input())).pending;
  await assert.rejects(repository.removePending(foreign.id, first.id), { code: 'not_found' });
  const removed = await repository.removePending(root.id, first.id);
  assert.equal(removed.status, 'cancelled');
  assert.deepEqual(await repository.removePending(root.id, first.id), removed);
  const second = (await repository.enqueuePending(root.id, input())).pending;
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  const child = await repository.promotePending();
  assert.ok(child);
  await assert.rejects(repository.removePending(root.id, second.id), { code: 'conflict' });
  assert.equal((await repository.getTask(child.id)).status, 'queued');
});

for (const terminal of ['failed', 'cancelled', 'interrupted'] as const) {
  test(`${terminal} pauses pending work until explicit resume, including across reopen`, async t => {
    const state = await fixture(t);
    let repository = state.repository;
    const root = await active(repository);
    await repository.setTaskSession(root.id, randomUUID());
    const first = (await repository.enqueuePending(root.id, input('First'))).pending;
    const second = (await repository.enqueuePending(root.id, input('Second'))).pending;
    if (terminal === 'failed') await repository.finishTask(root.id, { exitCode: 1 });
    else if (terminal === 'cancelled') await repository.cancelTask(root.id);
    else await repository.interruptRunningTasks();
    assert.equal(await repository.promotePending(), null);
    repository = await state.reopen();
    assert.equal(await repository.promotePending(), null);
    const pending = (await repository.listPending(root.id)).items;
    assert.equal(pending.find(item => item.id === first.id)?.status, 'paused');
    assert.equal(pending.find(item => item.id === second.id)?.status, 'paused');
    await repository.resumePending(root.id);
    const child = await repository.promotePending();
    assert.ok(child);
    assert.equal(child.parentTaskId, root.id);
    assert.deepEqual(child.parts, first.parts);
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 1 });
    assert.equal(await repository.promotePending(), null, 'resume grants no permission to advance past another failure');
  });
}

test('missing provider session never dispatches a followup into a fresh conversation', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  await repository.enqueuePending(root.id, input());
  await repository.finishTask(root.id, { exitCode: 0 });
  assert.equal(await repository.promotePending(), null);
  await assert.rejects(repository.resumePending(root.id), { code: 'conflict' });
});

test('pending queue bounds admission and cancelling an entry releases its active slot', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  const requests = Array.from({ length: 16 }, (_, index) => input(`Message ${index}`));
  const admitted = await Promise.all(requests.map(request => repository.enqueuePending(root.id, request)));
  await assert.rejects(repository.enqueuePending(root.id, input('Overflow')));
  assert.equal((await repository.enqueuePending(root.id, requests[0]!)).created, false);
  await repository.removePending(root.id, admitted[0]!.pending.id);
  assert.equal((await repository.enqueuePending(root.id, input('Replacement'))).created, true);
});

test('Stop after promotion pauses remaining work and cancelled child cannot complete over Stop', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  await repository.enqueuePending(root.id, input('First'));
  const second = (await repository.enqueuePending(root.id, input('Second'))).pending;
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  const child = await repository.promotePending();
  assert.ok(child);
  await repository.claimNextTask();
  await repository.cancelTask(child.id);
  await repository.finishTask(child.id, { exitCode: 0 });
  assert.equal((await repository.getTask(child.id)).status, 'cancelled');
  assert.equal(await repository.promotePending(), null);
  assert.equal((await repository.listPending(root.id)).items.find(item => item.id === second.id)?.status, 'paused');
});

test('pending lifetime records remain bounded even when entries are repeatedly removed', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  let firstRequest: ReturnType<typeof input> | undefined;
  let firstId: string | undefined;
  for (let index = 0; index < 1000; index++) {
    const request = input(`Removed ${index}`);
    const entry = (await repository.enqueuePending(root.id, request)).pending;
    if (index === 0) { firstRequest = request; firstId = entry.id; }
    await repository.removePending(root.id, entry.id);
  }
  await assert.rejects(repository.enqueuePending(root.id, input('Over lifetime limit')));
  const retried = await repository.enqueuePending(root.id, firstRequest!);
  assert.equal(retried.created, false);
  assert.equal(retried.pending.id, firstId);
  assert.equal(retried.pending.status, 'cancelled');
});

test('Stop after successful completion but before promotion still pauses the pending queue', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  await repository.enqueuePending(root.id, input('Next'));
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  await repository.cancelTask(root.id);
  assert.equal((await repository.getTask(root.id)).status, 'succeeded');
  assert.equal(await repository.promotePending(), null);
  assert.equal((await repository.listPending(root.id)).items[0]?.status, 'paused');
});

test('promotion beyond the former task quota preserves independent queued work', async t => {
  const { repository } = await fixture(t);
  const root = await active(repository);
  await repository.enqueuePending(root.id, input('Over task capacity'));
  const independent = (await repository.createTask({ ...input('Independent'), provider: 'codex' })).task;
  await repository.queueTask(independent.id, 'project');
  for (let index = 2; index < 1005; index++) {
    await repository.createTask({ ...input(`Task ${index}`), provider: 'codex' });
  }
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  const promoted = await repository.promotePending();
  assert.equal(promoted?.parentTaskId, root.id);
  assert.equal((await repository.listPending(root.id)).items.length, 0);
  assert.equal((await repository.claimNextTask())?.id, independent.id);
  assert.equal((await repository.getTask(independent.id)).status, 'running');
});

test('promotion broadcasts the pending pause even when no task is admitted', async t => {
  let changes = 0;
  const { repository } = await fixture(t, () => { changes++; });
  const root = await active(repository);
  await repository.enqueuePending(root.id, input('No session'));
  await repository.finishTask(root.id, { exitCode: 0 });
  const before = changes;
  assert.equal(await repository.promotePending(), null);
  assert.ok(changes > before);
  assert.equal((await repository.listPending(root.id)).items[0]?.status, 'paused');
});

test('pending attachment references persist across reopen and missing references reject atomically', async t => {
  const state = await fixture(t);
  let repository = state.repository;
  const root = await active(repository);
  const attachment = { id: randomUUID(), runnerId: state.identity, name: 'screen.png', mediaType: 'image/png' as const,
    bytes: 100, sha256: 'a'.repeat(64), width: 1, height: 1, createdAt: new Date().toISOString() };
  await repository.putAttachment(attachment);
  const request = { ...input('Read image'), parts: [{ type: 'text' as const, text: 'Read image' }, { type: 'attachment' as const, attachmentId: attachment.id }] };
  await assert.rejects(repository.enqueuePending(root.id, { ...request, parts: [{ type: 'attachment', attachmentId: randomUUID() }] }), { code: 'not_found' });
  assert.equal((await repository.listPending(root.id)).items.length, 0);
  const pending = await repository.enqueuePending(root.id, request);
  await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
  repository = await state.reopen();
  assert.deepEqual((await repository.listPending(root.id)).items[0]?.parts, request.parts);
  const child = await repository.promotePending();
  assert.ok(child);
  assert.deepEqual(child.parts, request.parts);
  assert.deepEqual(await repository.getAttachment(attachment.id), attachment);
  assert.equal((await repository.enqueuePending(root.id, request)).pending.id, pending.pending.id);
});

test('promotion savepoint rolls back partial task writes before pausing an admission failure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE attachments(id TEXT PRIMARY KEY); CREATE TABLE conversations(root_id TEXT PRIMARY KEY, latest_id TEXT); CREATE TABLE admission_writes(value TEXT);');
    db.exec(PENDING_SCHEMA);
    const root: Task = { id: randomUUID(), sequence: 1, runnerId: randomUUID(), provider: 'codex', status: 'succeeded', projectId: 'project', parts: input().parts, createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO tasks VALUES(?)').run(root.id);
    const pending = new PendingDatabase(db, {
      transaction: action => {
        db.exec('BEGIN');
        try { const value = action(); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      getTask: () => root, requireCapacity: () => {}, getAttachment: () => {},
      resumeState: () => ({ available: true, reason: null }),
      continueTask: () => {
        db.prepare('INSERT INTO admission_writes VALUES(?)').run('partial');
        db.prepare('INSERT INTO tasks VALUES(?)').run('partial-task');
        throw new RunnerError('quota_exceeded');
      },
    });
    pending.enqueuePending(root.id, input('Cannot admit'));
    assert.equal(pending.promotePending(), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM admission_writes').get()?.['n'], 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get()?.['n'], 1);
    assert.equal(pending.listPending(root.id).items[0]?.status, 'paused');
  } finally { db.close(); }
});
