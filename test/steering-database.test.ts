import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
const input = (text = 'Steer') => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text }] });
async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'steering-db-'));
 const identity = randomUUID();
 let repository = await openSqliteRepository(directory, identity);
 t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
 const root = (await repository.createTask({ ...input(), provider: 'codex' })).task;
 await repository.queueTask(root.id, 'project'); await repository.claimNextTask();
 return { root, get repository() { return repository; }, async reopen() { await repository.close(); repository = await openSqliteRepository(directory, identity); return repository; } };
}
test('steering claims survive restart, reject uncertain retries and replay accepted receipt after terminal', async t => {
 const state = await fixture(t); let r = state.repository; const id = state.root.id; const request = input();
 const claim = await r.claimSteer!(id, request); assert.equal(claim.accepted, false);
 r = await state.reopen();
 await assert.rejects(r.claimSteer!(id, request), { code: 'delivery_uncertain' });
 await assert.rejects(r.findSteer!(id, request), { code: 'delivery_uncertain' });
 const receipt = await r.acceptSteer!(id, claim.messageId);
 await r.acceptSteer!(id, claim.messageId);
 assert.equal((await r.listEvents(id, 0)).items.filter(event => event.type === 'task.input').length, 1);
 await r.finishTask(id, { exitCode: 0 });
 assert.deepEqual(await r.findSteer!(id, request), receipt);
 await assert.rejects(r.findSteer!(id, { ...request, parts: input('Different').parts }), { code: 'conflict' });
 await assert.rejects(r.claimSteer!(id, input()), { code: 'conflict' });
});
test('concurrent claims consume one delivery capability and validate attachments', async t => {
 const { repository: r, root } = await fixture(t); const request = input();
 const results = await Promise.allSettled([r.claimSteer!(root.id, request), r.claimSteer!(root.id, request)]);
 assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
 await assert.rejects(r.claimSteer!(root.id, { idempotencyKey: randomUUID(), parts: [{ type: 'attachment', attachmentId: randomUUID() }] }), { code: 'not_found' });
});
test('pending claim stays visibly uncertain until accepted and cannot duplicate by terminal promotion', async t => {
 const state = await fixture(t); let r = state.repository; const id = state.root.id;
 const pending = (await r.enqueuePending(id, input())).pending;
 const claim = await r.claimPendingSteer!(id, pending.id); assert.ok(claim);
 assert.equal((await r.listPending(id)).items[0]?.id, pending.id);
 assert.equal((await r.listPending(id)).items[0]?.status, 'uncertain');
 assert.equal(await r.claimPendingSteer!(id), null);
 await r.finishTask(id, { exitCode: 0, sessionId: randomUUID() });
 assert.equal(await r.promotePending(), null);
 r = await state.reopen();
 await assert.rejects(r.findPendingSteer!(id, pending.id), { code: 'delivery_uncertain' });
 const receipt = await r.acceptSteer!(id, claim.messageId);
 assert.deepEqual(await r.findPendingSteer!(id, pending.id), receipt);
 assert.equal((await r.listPending(id)).items.length, 0);
 assert.equal(await r.promotePending(), null);
});
test('cancelled queue is never automatically claimed', async t => {
 const { repository: r, root } = await fixture(t);
 await r.enqueuePending(root.id, input()); await r.cancelTask(root.id);
 await assert.rejects(r.claimPendingSteer!(root.id), { code: 'conflict' });
});
test('per-task steering capacity is bounded', async t => {
 const { repository: r, root } = await fixture(t);
 for (let i = 0; i < 32; i++) await r.claimSteer!(root.id, input());
 await assert.rejects(r.claimSteer!(root.id, input()), { code: 'quota_exceeded' });
});
test('known pre-delivery failure releases pending claim for retry, accepted delivery cannot release', async t => {
 const { repository: r, root } = await fixture(t);
 const pending = (await r.enqueuePending(root.id, input())).pending;
 const claim = await r.claimPendingSteer!(root.id, pending.id); assert.ok(claim);
 await r.releaseSteer!(root.id, claim.messageId);
 const retried = await r.claimPendingSteer!(root.id, pending.id); assert.ok(retried);
 assert.equal(retried.messageId, pending.id);
 await r.acceptSteer!(root.id, retried.messageId);
 await assert.rejects(r.releaseSteer!(root.id, retried.messageId), { code: 'conflict' });
});
test('foreign pending claims and stale task owners cannot redirect delivery', async t => {
 const { repository: r, root } = await fixture(t);
 const pending = (await r.enqueuePending(root.id, input())).pending;
 const other = (await r.createTask({ ...input(), provider: 'codex' })).task;
 await r.queueTask(other.id, 'other'); await r.claimNextTask();
 await assert.rejects(r.claimPendingSteer!(other.id, pending.id), { code: 'not_found' });
 await r.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
 const child = await r.promotePending(); assert.ok(child); await r.claimNextTask();
 await assert.rejects(r.claimSteer!(root.id, input()), { code: 'conflict' });
 assert.equal((await r.claimSteer!(child.id, input())).accepted, false);
});

test('uncertain pending can be dismissed without authorizing redelivery', async t => {
 const { repository: r, root } = await fixture(t);
 const pending = (await r.enqueuePending(root.id, input())).pending;
 await r.claimPendingSteer!(root.id, pending.id);
 assert.equal((await r.removePending(root.id, pending.id)).status, 'cancelled');
 assert.equal((await r.listPending(root.id)).items.length, 0);
 await assert.rejects(r.claimPendingSteer!(root.id, pending.id), { code: 'delivery_uncertain' });
 await r.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
 assert.equal(await r.promotePending(), null);
});
test('accepted user input remains replayable beyond the former output limit', async t => {
 const { repository: r, root } = await fixture(t);
 const request = input('Retain this instruction');
 const claim = await r.claimSteer!(root.id, request);
 await r.acceptSteer!(root.id, claim.messageId);
 for (let i = 0; i < 130; i++) await r.appendTaskOutput(root.id, 'stdout', 'x'.repeat(8191) + '\n');
 const events = await r.listEvents(root.id, 0);
 assert.equal(events.outputTruncatedBeforeSequence, undefined);
 const accepted = events.items.find(event => event.type === 'task.input');
 assert.deepEqual(accepted?.parts, request.parts);
 assert.equal(accepted?.messageId, request.idempotencyKey);
});

test('escaped accepted-input pages stay within transport budget without losing messages', async t => {
 const {repository:r,root}=await fixture(t);
 for(let i=0;i<16;i++) { const claim=await r.claimSteer!(root.id,input('x'+'\u0001'.repeat(47_999))); await r.acceptSteer!(root.id,claim.messageId); }
 let cursor=0;let count=0;let pages=0;
 for(;;) {
  const page=await r.listEvents(root.id,cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<4*1024*1024);
  count+=page.items.filter(event=>event.type==='task.input').length;pages++;
  if(page.nextCursor===null)break;
  assert.ok(page.nextCursor>cursor);cursor=page.nextCursor;
 }
 assert.equal(count,16);assert.ok(pages>1);
});

test('subagent lifecycle survives output beyond the former limit and restart independently of raw frames', async t => {
 const state=await fixture(t);let r=state.repository;
 const snapshot={entries:[{id:'task:child',taskId:'child',name:'Explorer',description:'Inspect project',state:'completed' as const,telemetryState:'completed' as const,steps:4}],truncated:false};
 await r.setTaskSubagents!(state.root.id,snapshot);
 for(let i=0;i<140;i++)await r.appendTaskOutput(state.root.id,'stdout','x'.repeat(8191)+'\n');
 r=await state.reopen();
 const page=await r.listEvents(state.root.id,0);
 assert.deepEqual(page.subagentLifecycle,snapshot);assert.equal(page.outputTruncatedBeforeSequence, undefined);
 await assert.rejects(r.setTaskSubagents!(state.root.id,{entries:[{...snapshot.entries[0]!,state:'failed'}],truncated:false}));
 await r.finishTask(state.root.id,{exitCode:0});
 await r.setTaskSubagents!(state.root.id,{entries:[],truncated:false});
 assert.deepEqual((await r.listEvents(state.root.id,0)).subagentLifecycle,snapshot);
});
