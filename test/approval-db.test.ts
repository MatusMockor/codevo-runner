import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import {
  APPROVAL_LIMITS, boundedApprovalText, parseAgentApprovalAnswer, parseAgentApprovalRequest,
  type AgentApprovalRequest,
} from '../src/domain/approvals.js';

type Repository = Awaited<ReturnType<typeof openSqliteRepository>>;

const approval = (taskId: string): AgentApprovalRequest => ({
  id: randomUUID(), taskId, provider: 'claudeCode', kind: 'command', title: 'Run a command?', detail: 'npm test',
  detailTruncated: false, facts: [{ label: 'Tool', value: 'Bash' }], decisions: ['allowOnce', 'allowForSession', 'deny'],
  status: 'pending', expiresAt: new Date(Date.now() + APPROVAL_LIMITS.timeoutMs).toISOString(),
});
const message = (text = 'Approve') => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text }] });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-approval-db-'));
  const runnerId = randomUUID();
  let changes = 0;
  let repository = await openSqliteRepository(directory, runnerId, () => changes++);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    changes: () => changes,
    get repository() { return repository; },
    async reopen() {
      await repository.close();
      repository = await openSqliteRepository(directory, runnerId, () => changes++);
      return repository;
    },
  };
}

async function running(repository: Repository, approvals = false) {
  const task = (await repository.createTask({ ...message(), provider: 'claude' })).task;
  await repository.queueTask(task.id, 'project', undefined, approvals);
  assert.equal((await repository.claimNextTask())?.id, task.id);
  return task;
}

async function statuses(repository: Repository, taskId: string) {
  return (await repository.listApprovals(taskId)).map(item => item.status);
}

test('approval wire parser is closed over keys, enums, decisions and byte limits', () => {
  const valid = approval(randomUUID());
  assert.deepEqual(parseAgentApprovalRequest(valid), valid);
  for (const invalid of [
    { ...valid, surprise: true },
    { ...valid, kind: 'mcpElicitation' },
    { ...valid, status: 'answered' },
    { ...valid, provider: 'claude' },
    { ...valid, decision: 'allowOnce' },
    { ...valid, decisions: ['allowOnce', 'allowAlways', 'deny'] },
    { ...valid, decisions: ['allowOnce'] },
    { ...valid, decisions: ['deny', 'deny'] },
    { ...valid, decisions: [] },
    { ...valid, title: ' ' },
    { ...valid, title: 'é'.repeat(129) },
    { ...valid, detail: 'x'.repeat(APPROVAL_LIMITS.detailBytes + 1) },
    { ...valid, detail: 'a\0b' },
    { ...valid, detailTruncated: 'no' },
    { ...valid, facts: Array.from({ length: 9 }, () => ({ label: 'Tool', value: 'Bash' })) },
    { ...valid, facts: [{ label: 'x'.repeat(65), value: '' }] },
    { ...valid, facts: [{ label: 'Tool', value: 'x'.repeat(2049) }] },
    { ...valid, facts: [{ label: 'Tool', value: 'Bash', extra: 1 }] },
    { ...valid, id: 'not-a-uuid' },
    { ...valid, expiresAt: 'tomorrow' },
    { ...valid, status: 'approved' },
    { ...valid, status: 'approved', decision: 'deny' },
    { ...valid, status: 'denied', decision: 'allowOnce' },
    { ...valid, status: 'approved', decision: 'allowForSession', decisions: ['allowOnce', 'deny'] },
    { ...valid, status: 'timedOut', decision: 'deny' },
  ]) assert.throws(() => parseAgentApprovalRequest(invalid), { code: 'invalid_input' });
  const maximal = {
    ...valid, kind: 'fileChange', title: 'é'.repeat(128), detail: 'x'.repeat(APPROVAL_LIMITS.detailBytes), detailTruncated: true,
    facts: Array.from({ length: 8 }, () => ({ label: 'x'.repeat(64), value: 'x'.repeat(2048) })),
    status: 'approved', decision: 'allowForSession',
  };
  assert.deepEqual(parseAgentApprovalRequest(maximal), maximal);
  assert.deepEqual(parseAgentApprovalRequest({ ...valid, status: 'denied', decision: 'deny' }).status, 'denied');
  assert.deepEqual(parseAgentApprovalAnswer({ decision: 'deny' }, valid), { decision: 'deny' });
  for (const answer of [{}, { decision: 'allowOnce', extra: true }, { decision: 'allowAlways' }, { decision: ['deny'] }, null, 'deny'])
    assert.throws(() => parseAgentApprovalAnswer(answer, valid), { code: 'invalid_input' });
  assert.throws(() => parseAgentApprovalAnswer({ decision: 'allowForSession' }, { decisions: ['allowOnce', 'deny'] }), { code: 'invalid_input' });
});

test('bounded approval text strips NUL and truncates on a UTF-8 boundary', () => {
  assert.deepEqual(boundedApprovalText('plain', 16), { text: 'plain', truncated: false });
  assert.deepEqual(boundedApprovalText('a\0b', 16), { text: 'ab', truncated: true });
  assert.deepEqual(boundedApprovalText('aé😀', 3), { text: 'aé', truncated: true });
  assert.deepEqual(boundedApprovalText('aé😀', 6), { text: 'aé', truncated: true });
  assert.deepEqual(boundedApprovalText('aé😀', 7), { text: 'aé😀', truncated: false });
  assert.deepEqual(boundedApprovalText('😀', 0), { text: '', truncated: true });
});

test('pending approvals are capped per task and eviction removes only the oldest settled row', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  await assert.rejects(f.repository.createApproval({ ...approval(task.id), provider: 'codex' }), { code: 'conflict' });
  const kept = await f.repository.createApproval(approval(task.id));
  const pending = [kept];
  while (pending.length < APPROVAL_LIMITS.pending) pending.push(await f.repository.createApproval(approval(task.id)));
  await assert.rejects(f.repository.createApproval(approval(task.id)), { code: 'quota_exceeded' });
  const settled: string[] = [];
  for (const item of pending.slice(1)) {
    await f.repository.answerApproval(task.id, item.id, 'deny');
    settled.push(item.id);
  }
  while (settled.length < APPROVAL_LIMITS.retained + 1) {
    const item = await f.repository.createApproval(approval(task.id));
    await f.repository.answerApproval(task.id, item.id, 'allowOnce');
    settled.push(item.id);
  }
  assert.equal(APPROVAL_LIMITS.retained, 32);
  assert.equal((await f.repository.listApprovals(task.id)).length, APPROVAL_LIMITS.retained + 2);
  const next = await f.repository.createApproval(approval(task.id));
  const listed = await f.repository.listApprovals(task.id);
  assert.deepEqual(listed.map(item => item.id), [kept.id, ...settled.slice(1), next.id]);
  assert.equal(listed[0]?.status, 'pending');
  assert.equal(listed.filter(item => item.status !== 'pending').length, 32);
  await assert.rejects(f.repository.answerApproval(task.id, settled[0]!, 'deny'), { code: 'not_found' });
});

test('stored approval bytes are bounded per task including JSON escaping', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  const large = () => ({ ...approval(task.id), detail: '\u0001'.repeat(APPROVAL_LIMITS.detailBytes),
    facts: Array.from({ length: 8 }, () => ({ label: 'Reason', value: '\u0001'.repeat(2048) })) });
  let admitted = 0;
  let rejected: unknown;
  while (admitted < APPROVAL_LIMITS.pending && rejected === undefined) {
    rejected = await f.repository.createApproval(large()).then(() => undefined, error => error);
    admitted += rejected === undefined ? 1 : 0;
  }
  assert.equal((rejected as { code?: string }).code, 'quota_exceeded');
  assert.ok(admitted > 0 && admitted < APPROVAL_LIMITS.pending);
  const stored = await f.repository.listApprovals(task.id);
  assert.equal(stored.length, admitted);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 2 * 1024 * 1024);
});

test('a full byte budget evicts the oldest settled approvals and never a pending one', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  const large = () => ({ ...approval(task.id), detail: '\u0001'.repeat(APPROVAL_LIMITS.detailBytes),
    facts: Array.from({ length: 8 }, () => ({ label: 'Reason', value: '\u0001'.repeat(2048) })) });
  const kept = await f.repository.createApproval(large());
  const settled: string[] = [];
  for (let index = 0; index < 14; index++) {
    const item = await f.repository.createApproval(large());
    await f.repository.answerApproval(task.id, item.id, 'deny');
    settled.push(item.id);
  }
  const stored = await f.repository.listApprovals(task.id);
  assert.ok(stored.length > 2 && stored.length < 15);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 2 * 1024 * 1024);
  assert.deepEqual(stored.map(item => item.id), [kept.id, ...settled.slice(settled.length - (stored.length - 1))]);
  assert.equal(stored[0]?.status, 'pending');
  await assert.rejects(f.repository.answerApproval(task.id, settled[0]!, 'deny'), { code: 'not_found' });
  while ((await statuses(f.repository, task.id)).some(status => status !== 'pending')) {
    const outcome = await f.repository.createApproval(large()).then(() => 'created', (error: { code?: string }) => error.code);
    if (outcome !== 'created') break;
  }
  assert.ok((await statuses(f.repository, task.id)).every(status => status === 'pending'));
  await assert.rejects(f.repository.createApproval(large()), { code: 'quota_exceeded' });
  assert.equal((await f.repository.listApprovals(task.id))[0]?.id, kept.id);
});

test('approval answers are idempotent, exclusive, validated and isolated per task', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  const other = await running(f.repository);
  const before = f.changes();
  const request = await f.repository.createApproval({ ...approval(task.id), decisions: ['allowOnce', 'deny'] });
  assert.ok(f.changes() > before);
  await assert.rejects(f.repository.answerApproval(other.id, request.id, 'allowOnce'), { code: 'not_found' });
  await assert.rejects(f.repository.answerApproval(task.id, randomUUID(), 'allowOnce'), { code: 'not_found' });
  await assert.rejects(f.repository.answerApproval(task.id, request.id, 'allowForSession'), { code: 'invalid_input' });
  const answered = await f.repository.answerApproval(task.id, request.id, 'allowOnce');
  assert.deepEqual(answered, { ...request, status: 'approved', decision: 'allowOnce' });
  assert.deepEqual(await f.repository.answerApproval(task.id, request.id, 'allowOnce'), answered);
  await assert.rejects(f.repository.answerApproval(task.id, request.id, 'deny'), { code: 'conflict' });
  await f.repository.finishTask(task.id, { exitCode: 0 });
  assert.deepEqual(await f.repository.answerApproval(task.id, request.id, 'allowOnce'), answered);
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.listApprovals(task.id), [answered]);
  assert.deepEqual(await reopened.listApprovals(other.id), []);
  await assert.rejects(reopened.listApprovals(randomUUID()), { code: 'not_found' });
});

test('task cancellation, completion and restart settle pending approvals and reject late answers', async t => {
  const f = await fixture(t);
  const transitions = [
    { settle: (id: string) => f.repository.cancelTask(id), status: 'cancelled' },
    { settle: (id: string) => f.repository.finishTask(id, { exitCode: 0 }), status: 'expired' },
    { settle: () => f.repository.interruptRunningTasks(), status: 'expired' },
    { settle: (id: string) => f.repository.expireApprovals(id), status: 'expired' },
  ];
  for (const transition of transitions) {
    const task = await running(f.repository);
    const request = await f.repository.createApproval(approval(task.id));
    await transition.settle(task.id);
    assert.deepEqual(await f.repository.listApprovals(task.id), [{ ...request, status: transition.status }]);
    await assert.rejects(f.repository.answerApproval(task.id, request.id, 'allowOnce'), { code: 'conflict' });
    assert.equal(await f.repository.timeoutApproval(task.id, request.id), false);
  }
});

test('approval timeout and cancellation transition exactly once and lose to an earlier answer', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  const timed = await f.repository.createApproval(approval(task.id));
  assert.equal(await f.repository.timeoutApproval(task.id, timed.id), true);
  const settled = f.changes();
  assert.equal(await f.repository.timeoutApproval(task.id, timed.id), false);
  assert.equal(f.changes(), settled);
  await assert.rejects(f.repository.answerApproval(task.id, timed.id, 'deny'), { code: 'conflict' });
  const answered = await f.repository.createApproval(approval(task.id));
  await f.repository.answerApproval(task.id, answered.id, 'deny');
  assert.equal(await f.repository.timeoutApproval(task.id, answered.id), false);
  await f.repository.settleApproval(task.id, answered.id, 'cancelled');
  const cancelled = await f.repository.createApproval(approval(task.id));
  await f.repository.settleApproval(task.id, cancelled.id, 'cancelled');
  assert.equal(await f.repository.timeoutApproval(task.id, cancelled.id), false);
  assert.deepEqual(await statuses(f.repository, task.id), ['timedOut', 'denied', 'cancelled']);
  assert.deepEqual((await f.repository.listApprovals(task.id))[1], { ...answered, status: 'denied', decision: 'deny' });
});

test('the approval opt-in is stored per admitted turn and never inherited from the conversation', async t => {
  const f = await fixture(t);
  const root = await running(f.repository, true);
  assert.equal(await f.repository.getTaskApprovals(root.id), true);
  await f.repository.queueTask(root.id, 'project', undefined, false);
  assert.equal(await f.repository.getTaskApprovals(root.id), true);
  await f.repository.setTaskSession(root.id, randomUUID());
  await f.repository.finishTask(root.id, { exitCode: 0 });
  const silent = (await f.repository.continueTask(root.id, message('Second'))).task;
  assert.equal(await f.repository.getTaskApprovals(silent.id), false);
  assert.equal((await f.repository.claimNextTask())?.id, silent.id);
  await f.repository.enqueuePending(silent.id, message('Third'), true);
  await f.repository.enqueuePending(silent.id, message('Fourth'));
  await f.repository.finishTask(silent.id, { exitCode: 0 });
  const announced = await f.repository.promotePending();
  assert.ok(announced);
  assert.equal(announced.parentTaskId, silent.id);
  assert.equal(await f.repository.getTaskApprovals(announced.id), true);
  await f.repository.claimNextTask();
  await f.repository.finishTask(announced.id, { exitCode: 0 });
  const quiet = await f.repository.promotePending();
  assert.ok(quiet);
  assert.equal(await f.repository.getTaskApprovals(quiet.id), false);
  const explicit = (await f.repository.createTask({ ...message(), provider: 'claude' })).task;
  assert.equal(await f.repository.getTaskApprovals(explicit.id), false);
  await assert.rejects(f.repository.getTaskApprovals(randomUUID()), { code: 'not_found' });
});

test('an older database gains the approval columns without a schema version change', async t => {
  const f = await fixture(t);
  const task = await running(f.repository, true);
  await f.repository.close();
  const path = join(f.directory, 'runner.sqlite');
  const old = new DatabaseSync(path);
  old.exec('DROP TABLE approvals; ALTER TABLE task_execution DROP COLUMN approvals; ALTER TABLE pending_messages DROP COLUMN approvals');
  assert.equal(old.prepare('PRAGMA user_version').get()!['user_version'], 9);
  old.close();
  const reopened = await f.reopen();
  assert.equal((await reopened.getTask(task.id)).status, 'running');
  assert.equal(await reopened.getTaskApprovals(task.id), false);
  assert.deepEqual(await reopened.listApprovals(task.id), []);
  const fresh = await running(reopened, true);
  assert.equal(await reopened.getTaskApprovals(fresh.id), true);
  await reopened.close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 9);
  for (const table of ['task_execution', 'pending_messages'])
    assert.ok(check.prepare(`PRAGMA table_info(${table})`).all().some(column => column['name'] === 'approvals'));
  check.close();
});

test('task reads derive awaiting only while an approval is pending and never persist it', async t => {
  const f = await fixture(t);
  const task = await running(f.repository);
  const idle = await running(f.repository);
  assert.equal(Object.hasOwn(await f.repository.getTask(task.id), 'awaiting'), false);
  const request = await f.repository.createApproval(approval(task.id));
  assert.equal((await f.repository.getTask(task.id)).awaiting, 'approval');
  assert.equal(Object.hasOwn(await f.repository.getTask(idle.id), 'awaiting'), false);
  const listed = (await f.repository.listTasks(0)).items;
  assert.deepEqual(listed.map(item => item.awaiting), ['approval', undefined]);
  assert.equal(Object.hasOwn(listed[1]!, 'awaiting'), false);
  await f.repository.close();
  const raw = new DatabaseSync(join(f.directory, 'runner.sqlite'));
  const payloads = raw.prepare('SELECT payload FROM tasks').all().map(row => String(row['payload']));
  raw.close();
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every(payload => !payload.includes('awaiting')));
  const reopened = await f.reopen();
  assert.equal((await reopened.getTask(task.id)).awaiting, 'approval');
  await reopened.interruptRunningTasks();
  assert.equal(Object.hasOwn(await reopened.getTask(task.id), 'awaiting'), false);
  assert.deepEqual(await reopened.listApprovals(task.id), [{ ...request, status: 'expired' }]);
  const next = await running(reopened);
  const answered = await reopened.createApproval(approval(next.id));
  assert.equal((await reopened.getTask(next.id)).awaiting, 'approval');
  await reopened.answerApproval(next.id, answered.id, 'deny');
  assert.equal(Object.hasOwn(await reopened.getTask(next.id), 'awaiting'), false);
  assert.ok((await reopened.listTasks(0)).items.every(item => !Object.hasOwn(item, 'awaiting')));
});
