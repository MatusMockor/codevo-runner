import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApprovalService } from '../src/application/approval-service.js';
import { APPROVAL_LIMITS, type AgentApprovalInput } from '../src/domain/approvals.js';
import { EXECUTION_LIMITS } from '../src/domain/execution.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const input: AgentApprovalInput = {
  kind: 'command', title: 'Run a command?', detail: 'npm test', detailTruncated: false,
  facts: [{ label: 'Tool', value: 'Bash' }], decisions: ['allowOnce', 'deny'],
};

async function fixture(t: TestContext, timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-approval-service-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  const service = new ApprovalService(repository, timeoutMs === undefined ? {} : { timeoutMs });
  t.after(async () => {
    await service.expire().catch(() => undefined);
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const running = async () => {
    const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Approve' }] })).task;
    await repository.queueTask(task.id, 'project');
    const claimed = await repository.claimNextTask();
    assert.equal(claimed?.id, task.id);
    return claimed!;
  };
  const pending = async (taskId: string, count: number) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const items = (await repository.listApprovals(taskId)).filter(item => item.status === 'pending');
      if (items.length === count) return items;
      assert.ok(Date.now() < deadline, 'Expected pending approvals were not persisted');
      await delay(5);
    }
  };
  return { repository, service, running, pending };
}

const outcome = (asked: Promise<unknown>) => asked.then(value => ({ value }), (error: { code?: string }) => ({ code: error.code }));

test('ask persists a pending approval and an answer resolves exactly the invocation that asked', async t => {
  const f = await fixture(t);
  const task = await f.running();
  let firstSettled = false;
  const first = f.service.ask(task, input, new AbortController().signal).finally(() => { firstSettled = true; });
  const [stored] = await f.pending(task.id, 1);
  assert.ok(stored);
  assert.equal(stored.provider, 'codex');
  assert.equal(stored.taskId, task.id);
  assert.deepEqual({ kind: stored.kind, title: stored.title, detail: stored.detail, facts: stored.facts, decisions: stored.decisions }, {
    kind: input.kind, title: input.title, detail: input.detail, facts: input.facts, decisions: input.decisions });
  const remaining = Date.parse(stored.expiresAt) - Date.now();
  assert.ok(remaining > APPROVAL_LIMITS.timeoutMs - 60_000 && remaining <= APPROVAL_LIMITS.timeoutMs);
  const second = f.service.ask(task, input, new AbortController().signal);
  const later = (await f.pending(task.id, 2)).find(item => item.id !== stored.id)!;
  assert.equal(firstSettled, false);
  assert.deepEqual(await f.service.answer(task.id, later.id, { decision: 'deny' }), { ...later, status: 'denied', decision: 'deny' });
  assert.equal(await second, 'deny');
  assert.equal(firstSettled, false);
  await assert.rejects(f.service.answer(task.id, stored.id, { decision: 'allowForSession' }), { code: 'invalid_input' });
  await assert.rejects(f.service.answer(task.id, stored.id, { decision: 'allowOnce', extra: true }), { code: 'invalid_input' });
  assert.equal((await f.service.answer(task.id, stored.id, { decision: 'allowOnce' })).status, 'approved');
  assert.equal(await first, 'allowOnce');
  assert.equal((await f.service.answer(task.id, stored.id, { decision: 'allowOnce' })).status, 'approved');
  await assert.rejects(f.service.answer(task.id, stored.id, { decision: 'deny' }), { code: 'conflict' });
  assert.deepEqual((await f.service.list(task.id)).map(item => item.status), ['approved', 'denied']);
});

test('an unanswered approval times out without a decision and rejects a late answer', async t => {
  const f = await fixture(t, 40);
  const task = await f.running();
  assert.equal(await f.service.ask(task, input, new AbortController().signal), 'unanswered');
  const [stored] = await f.service.list(task.id);
  assert.ok(stored);
  assert.equal(stored.status, 'timedOut');
  assert.equal(Object.hasOwn(stored, 'decision'), false);
  await assert.rejects(f.service.answer(task.id, stored.id, { decision: 'allowOnce' }), { code: 'conflict' });
  assert.equal((await f.service.list(task.id))[0]?.status, 'timedOut');
});

test('an answer racing the timeout yields one provider decision that matches the stored status', async t => {
  const f = await fixture(t, 30);
  const task = await f.running();
  for (let attempt = 0; attempt < 14; attempt++) {
    const asked = f.service.ask(task, input, new AbortController().signal);
    const [stored] = await f.pending(task.id, 1);
    assert.ok(stored);
    await delay(18 + attempt);
    const answered = await f.service.answer(task.id, stored.id, { decision: 'allowOnce' }).then(() => true, (error: { code?: string }) => {
      assert.equal(error.code, 'conflict');
      return false;
    });
    const decision = await asked;
    const status = (await f.service.list(task.id)).find(item => item.id === stored.id)?.status;
    assert.deepEqual([decision, status], answered ? ['allowOnce', 'approved'] : ['unanswered', 'timedOut']);
  }
});

test('aborting the request signal cancels the approval and rejects a late answer', async t => {
  const f = await fixture(t);
  const task = await f.running();
  const abort = new AbortController();
  const asked = outcome(f.service.ask(task, input, abort.signal));
  const [stored] = await f.pending(task.id, 1);
  assert.ok(stored);
  abort.abort();
  assert.deepEqual(await asked, { code: 'conflict' });
  assert.equal((await f.service.list(task.id))[0]?.status, 'cancelled');
  await assert.rejects(f.service.answer(task.id, stored.id, { decision: 'allowOnce' }), { code: 'conflict' });
  await assert.rejects(f.service.ask(task, input, abort.signal));
  assert.equal((await f.service.list(task.id)).length, 1);
});

test('expiry rejects only the waiters of its task and answers stay bound to their task', async t => {
  const f = await fixture(t);
  const first = await f.running();
  const second = await f.running();
  const expired = outcome(f.service.ask(first, input, new AbortController().signal));
  const kept = f.service.ask(second, input, new AbortController().signal);
  const [stale] = await f.pending(first.id, 1);
  const [live] = await f.pending(second.id, 1);
  assert.ok(stale && live);
  await assert.rejects(f.service.answer(first.id, live.id, { decision: 'allowOnce' }), { code: 'not_found' });
  await assert.rejects(f.service.answer(randomUUID(), live.id, { decision: 'allowOnce' }), { code: 'not_found' });
  await assert.rejects(f.service.answer('not-a-task', live.id, { decision: 'allowOnce' }), { code: 'invalid_input' });
  await f.service.expire(first.id);
  assert.deepEqual(await expired, { code: 'conflict' });
  assert.equal((await f.service.list(first.id))[0]?.status, 'expired');
  await assert.rejects(f.service.answer(first.id, stale.id, { decision: 'allowOnce' }), { code: 'conflict' });
  assert.equal((await f.service.list(second.id))[0]?.status, 'pending');
  assert.equal((await f.service.answer(second.id, live.id, { decision: 'allowOnce' })).status, 'approved');
  assert.equal(await kept, 'allowOnce');
});

test('a persisted approval without a live waiter cannot be answered', async t => {
  const f = await fixture(t);
  const task = await f.running();
  const restarted = new ApprovalService(f.repository);
  const asked = outcome(f.service.ask(task, input, new AbortController().signal));
  const [stored] = await f.pending(task.id, 1);
  assert.ok(stored);
  await assert.rejects(restarted.answer(task.id, stored.id, { decision: 'allowOnce' }), { code: 'conflict' });
  assert.equal((await f.service.list(task.id))[0]?.status, 'pending');
  await f.service.expire();
  assert.deepEqual(await asked, { code: 'conflict' });
});

test('the runner-wide waiter cap rejects further approvals as busy without persisting them', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const waiters: Promise<unknown>[] = [];
  for (let index = 0; index < EXECUTION_LIMITS.activeTasks; index++) {
    const task = await f.running();
    for (let slot = 0; slot < APPROVAL_LIMITS.pending; slot++) waiters.push(outcome(f.service.ask(task, input, new AbortController().signal)));
    await f.pending(task.id, APPROVAL_LIMITS.pending);
  }
  const overflow = await f.running();
  await assert.rejects(f.service.ask(overflow, input, new AbortController().signal), { code: 'busy' });
  assert.deepEqual(await f.service.list(overflow.id), []);
  await f.service.expire();
  const settled = await Promise.all(waiters);
  assert.equal(settled.length, EXECUTION_LIMITS.activeTasks * APPROVAL_LIMITS.pending);
  assert.ok(settled.every(result => (result as { code?: string }).code === 'conflict'));
  assert.equal(await f.service.ask(overflow, input, AbortSignal.abort()).then(() => 'resolved', () => 'rejected'), 'rejected');
});
