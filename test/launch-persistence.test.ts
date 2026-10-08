import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { parseTaskInput } from '../src/domain/task-input.js';
import { parseContinueTask } from '../src/domain/task-resume.js';
const input = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Continue' }] });
const claude = { provider: 'claudeCode' as const, model: 'sonnet' as const, mode: 'plan' as const, effort: 'high' as const };
const codex = { provider: 'codex' as const, model: 'default' as const, mode: 'default' as const };

test('launch parsing accepts Claude continuation and rejects unknown fields and provider mismatch', () => {
  assert.equal(parseContinueTask({ ...input(), launch: claude }).launch?.provider, 'claudeCode');
  assert.throws(() => parseTaskInput({ ...input(), provider: 'codex', launch: claude }), { code: 'invalid_input' });
  assert.throws(() => parseContinueTask({ ...input(), launch: claude, extra: true }), { code: 'invalid_input' });
  assert.throws(() => parseContinueTask({ ...input(), launch: null }), { code: 'invalid_input' });
});

test('real SQLite preserves canonical launch, rejects changed retry intent and inherits per-turn options after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-persistence-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const request = parseTaskInput({ ...input(), provider: 'claude', launch: claude });
    const root = (await repository.createTask(request)).task;
    assert.deepEqual(root.launch, request.launch);
    assert.equal((await repository.createTask({ ...request, launch: { ...claude, context: '200k', fastMode: false, thinkingMode: false } })).created, false);
    await assert.rejects(repository.createTask({ ...request, launch: { ...claude, effort: 'low' } }), { code: 'conflict' });
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
    await assert.rejects(repository.continueTask(root.id, { ...input(), launch: codex }), { code: 'invalid_input' });
    const continuation = input();
    const child = (await repository.continueTask(root.id, continuation)).task;
    assert.deepEqual(child.launch, root.launch);
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 0 });
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual((await repository.getTask(child.id)).launch, root.launch);
    assert.equal((await repository.continueTask(root.id, continuation)).created, false);
    await assert.rejects(repository.continueTask(root.id, { ...continuation, launch: claude }), { code: 'conflict' });
    const changed = parseContinueTask({ ...input(), launch: { ...claude, effort: 'low' } });
    const third = (await repository.continueTask(child.id, changed)).task;
    assert.deepEqual(third.launch, changed.launch);
    assert.deepEqual((await repository.getTask(child.id)).launch, root.launch);
    assert.equal((await repository.findContinuation(child.id, changed))?.created, false);
    await assert.rejects(repository.findContinuation(child.id, { ...changed, launch: claude }), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an omitted Claude context is stored, queued and returned as omitted and never invented', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-context-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  const hasContext = (launch: unknown) => Object.hasOwn(launch as object, 'context');
  try {
    const omitted = { ...claude, model: 'claude-opus-5-5' as const };
    const request = parseTaskInput({ ...input(), provider: 'claude', launch: omitted });
    assert.equal(hasContext(request.launch), false);
    const root = (await repository.createTask(request)).task;
    assert.equal(hasContext(root.launch), false);
    const sameIntent = await repository.createTask({ ...request, launch: { ...omitted, context: '200k' } });
    assert.equal(sameIntent.created, false);
    assert.equal(hasContext(sameIntent.task.launch), false);
    await assert.rejects(repository.createTask({ ...request, launch: { ...omitted, context: '1m' } }), { code: 'conflict' });
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    const queued = parseContinueTask({ ...input(), launch: omitted });
    const pending = (await repository.enqueuePending(root.id, queued)).pending;
    assert.equal(hasContext(pending.launch), false);
    assert.equal((await repository.enqueuePending(root.id, { ...queued, launch: { ...omitted, context: '200k' } })).created, false);
    await assert.rejects(repository.enqueuePending(root.id, { ...queued, launch: { ...omitted, context: '1m' } }), { code: 'conflict' });
    assert.equal(hasContext((await repository.listPending(root.id)).items[0]?.launch), false);
    assert.ok(await repository.claimPendingSteer!(root.id, pending.id));
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual((await repository.getTask(root.id)).launch, request.launch);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rows an earlier runner wrote with an invented 200k stay readable, retryable and steerable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-context-legacy-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    await repository.close();
    const [draft, root, child, queued] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const keys = { draft: randomUUID(), root: randomUUID(), child: randomUUID(), queued: randomUUID() };
    const launch = '{"provider":"claudeCode","model":"claude-opus-5-5","mode":"plan","effort":"high","context":"200k","fastMode":false,"thinkingMode":false}';
    const parts = '[{"type":"text","text":"Continue"}]';
    const createdAt = '2026-10-01T00:00:00.000Z';
    const task = (fields: string) => `{${fields},"sequence":0,"runnerId":"${identity}","provider":"claude","launch":${launch},"parts":${parts},"createdAt":"${createdAt}"}`;
    const created = `{"launch":${launch},"provider":"claude","parts":${parts}}`;
    const db = new DatabaseSync(join(directory, 'runner.sqlite'));
    try {
      const insert = db.prepare('INSERT INTO tasks(id,key,fingerprint,payload) VALUES(?,?,?,?)');
      insert.run(draft, keys.draft, created, task(`"id":"${draft}","status":"draft"`));
      insert.run(root, keys.root, created, task(`"id":"${root}","projectId":"project","status":"succeeded"`));
      insert.run(child, keys.child, `{"parentTaskId":"${root}","parts":${parts},"launch":${launch}}`,
        task(`"id":"${child}","projectId":"project","conversationId":"${root}","parentTaskId":"${root}","status":"running"`));
      db.prepare('INSERT INTO conversations(root_id,latest_id,session_id) VALUES(?,?,?)').run(root, child, randomUUID());
      db.prepare('INSERT INTO pending_queues(root_id) VALUES(?)').run(root);
      db.prepare('INSERT INTO pending_messages(id,root_id,key,fingerprint,dispatch_key,payload) VALUES(?,?,?,?,?,?)').run(queued, root, keys.queued,
        `{"root":"${root}","parts":${parts},"launch":${launch}}`, randomUUID(),
        `{"id":"${queued}","conversationId":"${root}","status":"queued","parts":${parts},"launch":${launch},"createdAt":"${createdAt}","taskId":null}`);
    } finally { db.close(); }
    repository = await openSqliteRepository(directory, identity);
    const stored = JSON.parse(launch);
    const omitted = { ...claude, model: 'claude-opus-5-5' as const };
    const changed = { ...omitted, context: '1m' as const };
    const message = { parts: input().parts };

    assert.deepEqual((await repository.getTask(child)).launch, stored);
    const retried = await repository.createTask({ ...message, idempotencyKey: keys.draft, provider: 'claude', launch: omitted });
    assert.deepEqual([retried.created, retried.task.id, retried.task.launch], [false, draft, stored]);
    await assert.rejects(repository.createTask({ ...message, idempotencyKey: keys.draft, provider: 'claude', launch: changed }), { code: 'conflict' });

    const continued = await repository.continueTask(root, { ...message, idempotencyKey: keys.child, launch: omitted });
    assert.deepEqual([continued.created, continued.task.id, continued.task.launch], [false, child, stored]);
    await assert.rejects(repository.continueTask(root, { ...message, idempotencyKey: keys.child, launch: changed }), { code: 'conflict' });

    const requeued = await repository.enqueuePending(child, { ...message, idempotencyKey: keys.queued, launch: omitted });
    assert.deepEqual([requeued.created, requeued.pending.id, requeued.pending.launch], [false, queued, stored]);
    await assert.rejects(repository.enqueuePending(child, { ...message, idempotencyKey: keys.queued, launch: changed }), { code: 'conflict' });

    const fresh = (await repository.enqueuePending(child, { ...input(), launch: omitted })).pending;
    assert.equal(Object.hasOwn(fresh.launch as object, 'context'), false);
    assert.ok(await repository.claimPendingSteer!(child, fresh.id));
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('omitting launch preserves legacy task shape and idempotency after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-legacy-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const request = { ...input(), provider: 'codex' as const };
    const root = (await repository.createTask(request)).task;
    assert.equal(Object.hasOwn(root, 'launch'), false);
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.equal((await repository.createTask(request)).created, false);
    await assert.rejects(repository.createTask({ ...request, launch: codex }), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});


test('Codex effort survives continuation retries, inheritance and SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-codex-effort-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const root = (await repository.createTask(parseTaskInput({ ...input(), provider: 'codex', launch: codex }))).task;
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
    const request = parseContinueTask({ ...input(), launch: { ...codex, model: 'gpt-6.1-sol', effort: 'high' } });
    const child = (await repository.continueTask(root.id, request)).task;
    assert.deepEqual(child.launch, request.launch);
    assert.equal((await repository.continueTask(root.id, request)).created, false);
    await assert.rejects(repository.continueTask(root.id, { ...request, launch: { ...codex, model: 'gpt-6.1-sol', effort: 'low' } }), { code: 'conflict' });
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 0 });
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual((await repository.getTask(child.id)).launch, request.launch);
    const inherited = (await repository.continueTask(child.id, input())).task;
    assert.deepEqual(inherited.launch, request.launch);
    assert.deepEqual((await repository.getTask(root.id)).launch, codex);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
