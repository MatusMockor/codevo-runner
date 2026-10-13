import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { LIMITS, type Attachment } from '../src/domain/contracts.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { schemaShape } from './maintenance-fixture.js';

const HOUR = 3_600_000;
const MEBIBYTE = 1024 * 1024;
type Repository = Awaited<ReturnType<typeof openSqliteRepository>>;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-eviction-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(directory, runnerId);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const now = Date.now();
  const file = (ageMs: number, overrides: Partial<Attachment> = {}): Attachment => ({ id: randomUUID(), runnerId, name: 'data.bin', kind: 'file',
    mediaType: 'application/octet-stream', bytes: 1, sha256: 'a'.repeat(64), createdAt: new Date(now - ageMs).toISOString(), ...overrides } as Attachment);
  const put = async (ageMs: number, overrides: Partial<Attachment> = {}) => {
    const value = file(ageMs, overrides);
    assert.deepEqual(await repository.putAttachment(value), { attachment: value, created: true });
    return value.id;
  };
  const rows = () => {
    const db = new DatabaseSync(join(directory, 'runner.sqlite'), { readOnly: true });
    try {
      return new Map(db.prepare('SELECT id,bytes FROM attachments').all().map(row => [row['id'] as string, Number(row['bytes'])]));
    } finally { db.close(); }
  };
  const live = () => [...rows().values()].filter(bytes => bytes > 0);
  const pinnedSchema = () => {
    const pinned = JSON.parse(readFileSync(new URL('../../test/fixtures/sqlite-schema-shape.json', import.meta.url), 'utf8')) as ReturnType<typeof schemaShape>;
    assert.deepEqual(schemaShape(join(directory, 'runner.sqlite')), pinned);
  };
  return { repository, runnerId, file, put, rows, live, pinnedSchema };
}

const reference = (attachmentId: string) => ({ idempotencyKey: randomUUID(), parts: [{ type: 'attachment' as const, attachmentId }] });
async function running(repository: Repository, attachmentId: string) {
  const task = (await repository.createTask({ ...reference(attachmentId), provider: 'codex' })).task;
  await repository.queueTask(task.id, 'project');
  assert.equal((await repository.claimNextTask())?.id, task.id);
  return task.id;
}

test('a full store evicts the minimal oldest prefix ordered by creation time and then id', async t => {
  const { repository, file, put, live, rows, pinnedSchema } = await fixture(t);
  const oldest = await put(5 * HOUR);
  const tied = [randomUUID(), randomUUID()].sort();
  const tiedAt = file(4 * HOUR).createdAt;
  for (const id of [...tied].reverse()) assert.equal((await repository.putAttachment(file(0, { id, createdAt: tiedAt }))).created, true);
  for (let index = 0; index < LIMITS.attachments - 3; index++) await put(HOUR - index);
  assert.equal(live().length, LIMITS.attachments);

  for (const expected of [oldest, tied[0]!, tied[1]!]) {
    const incoming = file(0);
    assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: true, evicted: [expected] });
    await assert.rejects(repository.getAttachment(expected), { code: 'not_found' });
    assert.equal(rows().has(expected), false);
    assert.equal(live().length, LIMITS.attachments);
    assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: false });
  }
  pinnedSchema();
});

test('the byte budget evicts exactly as many of the oldest attachments as the incoming file needs', async t => {
  const { repository, file, put, live } = await fixture(t);
  const small = [await put(9 * HOUR, { bytes: MEBIBYTE }), await put(8 * HOUR, { bytes: MEBIBYTE }), await put(7 * HOUR, { bytes: MEBIBYTE })];
  const large: string[] = [];
  for (let index = 0; index < 40; index++) large.push(await put(6 * HOUR - index, { bytes: LIMITS.fileAttachmentBytes }));
  await put(HOUR, { bytes: 44 * MEBIBYTE });
  assert.equal(live().reduce((sum, bytes) => sum + bytes, 0), LIMITS.storageBytes - MEBIBYTE);
  const exact = file(0, { bytes: MEBIBYTE });
  assert.deepEqual(await repository.putAttachment(exact), { attachment: exact, created: true });
  assert.equal(live().reduce((sum, bytes) => sum + bytes, 0), LIMITS.storageBytes);

  const incoming = file(0, { bytes: 3 * MEBIBYTE });
  assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: true, evicted: small });
  assert.equal(live().reduce((sum, bytes) => sum + bytes, 0), LIMITS.storageBytes);
  const next = file(0, { bytes: LIMITS.fileAttachmentBytes });
  assert.deepEqual(await repository.putAttachment(next), { attachment: next, created: true, evicted: [large[0]] });
  const impossible = file(0, { bytes: LIMITS.storageBytes + 1 });
  const before = live().length;
  await assert.rejects(repository.putAttachment(impossible), { code: 'quota_exceeded' });
  assert.equal(live().length, before);
  assert.equal((await repository.getAttachment(large[1]!)).id, large[1]);
  await assert.rejects(repository.putAttachment(file(0, { bytes: 0 })), { code: 'invalid_input' });
});

test('pinned attachments are never evicted and a store with nothing evictable refuses without evicting', async t => {
  const { repository, file, put, rows, live, pinnedSchema } = await fixture(t);
  const finishedRef = await put(10 * HOUR);
  const finished = await running(repository, finishedRef);
  await repository.finishTask(finished, { exitCode: 0 });
  const runningRef = await put(20 * HOUR);
  const active = await running(repository, runningRef);
  const queuedRef = await put(20 * HOUR);
  const queued = (await repository.createTask({ ...reference(queuedRef), provider: 'codex' })).task;
  await repository.queueTask(queued.id, 'project');
  const draftRef = await put(20 * HOUR);
  await repository.createTask({ ...reference(draftRef), provider: 'codex' });
  const pendingRef = await put(20 * HOUR);
  await repository.enqueuePending(active, reference(pendingRef));
  const removedPendingRef = await put(9 * HOUR);
  const removed = await repository.enqueuePending(active, reference(removedPendingRef));
  await repository.removePending(active, removed.pending.id);
  const undeliveredRef = await put(19 * HOUR);
  assert.equal((await repository.claimSteer!(active, reference(undeliveredRef))).accepted, false);
  const deliveredRef = await put(8 * HOUR);
  const delivered = await repository.claimSteer!(active, reference(deliveredRef));
  await repository.acceptSteer!(active, delivered.messageId);
  const loose = await put(7 * HOUR);
  const graceRef = await put(LIMITS.attachmentEvictionGraceMs - 5 * 60_000);
  const pastGraceRef = await put(LIMITS.attachmentEvictionGraceMs + 60_000);
  for (let index = 0; index < LIMITS.attachments - 11; index++) await put(0);
  assert.equal(live().length, LIMITS.attachments);

  for (const expected of [finishedRef, removedPendingRef, loose, pastGraceRef]) {
    const incoming = file(0);
    assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: true, evicted: [expected] });
  }
  const snapshot = rows();
  assert.equal(snapshot.get(finishedRef), 0);
  assert.equal(snapshot.get(removedPendingRef), 0);
  assert.equal(snapshot.get(deliveredRef), 1);
  assert.equal(snapshot.get(undeliveredRef), 1);
  assert.equal(snapshot.has(loose), false);
  assert.equal(snapshot.has(pastGraceRef), false);

  const refused = file(0);
  await assert.rejects(repository.putAttachment(refused), { code: 'quota_exceeded' });
  await assert.rejects(repository.getAttachment(refused.id), { code: 'not_found' });
  assert.deepEqual(rows(), snapshot);
  for (const pinned of [runningRef, queuedRef, draftRef, pendingRef, undeliveredRef, deliveredRef, graceRef]) assert.equal((await repository.getAttachment(pinned)).id, pinned);

  await repository.cancelTask(queued.id);
  const afterCancel = file(0);
  assert.deepEqual(await repository.putAttachment(afterCancel), { attachment: afterCancel, created: true, evicted: [queuedRef] });
  await assert.rejects(repository.putAttachment(file(0)), { code: 'quota_exceeded' });
  await repository.finishTask(active, { exitCode: 0 });
  for (const expected of [runningRef, undeliveredRef, deliveredRef]) {
    const incoming = file(0);
    assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: true, evicted: [expected] });
    await assert.rejects(repository.getAttachment(expected), { code: 'not_found' });
  }
  assert.equal(rows().get(runningRef), 0);
  assert.equal(rows().has(undeliveredRef), false);
  assert.equal(rows().has(deliveredRef), false);
  await assert.rejects(repository.putAttachment(file(0)), { code: 'quota_exceeded' });
  for (const pinned of [draftRef, pendingRef, graceRef]) assert.equal((await repository.getAttachment(pinned)).id, pinned);
  assert.equal(live().length, LIMITS.attachments);
  pinnedSchema();
});

test('steering input of a cancelled turn stops pinning whether or not it was delivered', async t => {
  const { repository, file, put, live } = await fixture(t);
  const active = await running(repository, await put(0));
  const undeliveredRef = await put(3 * HOUR);
  assert.equal((await repository.claimSteer!(active, reference(undeliveredRef))).accepted, false);
  const deliveredRef = await put(2 * HOUR);
  const delivered = await repository.claimSteer!(active, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'see' }, { type: 'attachment', attachmentId: deliveredRef }] });
  await repository.acceptSteer!(active, delivered.messageId);
  for (let index = 0; index < LIMITS.attachments - 3; index++) await put(0);
  assert.equal(live().length, LIMITS.attachments);
  await assert.rejects(repository.putAttachment(file(0)), { code: 'quota_exceeded' });
  assert.equal((await repository.cancelTask(active)).status, 'cancelled');
  for (const expected of [undeliveredRef, deliveredRef]) {
    const incoming = file(0);
    assert.deepEqual(await repository.putAttachment(incoming), { attachment: incoming, created: true, evicted: [expected] });
  }
  await assert.rejects(repository.putAttachment(file(0)), { code: 'quota_exceeded' });
  assert.equal(live().length, LIMITS.attachments);
});

test('an evicted attachment is unknown to new task, continuation, pending and steering input until it is uploaded again', async t => {
  const { repository, file, put, rows, pinnedSchema } = await fixture(t);
  const historic = file(6 * HOUR);
  await repository.putAttachment(historic);
  const source = await running(repository, historic.id);
  await repository.finishTask(source, { exitCode: 0, sessionId: randomUUID() });
  const abandoned = await put(5 * HOUR);
  for (let index = 0; index < LIMITS.attachments - 2; index++) await put(HOUR);
  const kept = file(0);
  const another = file(0);
  assert.deepEqual((await repository.putAttachment(kept)).evicted, [historic.id]);
  assert.deepEqual((await repository.putAttachment(another)).evicted, [abandoned]);
  assert.equal(rows().get(historic.id), 0);
  assert.equal(rows().has(abandoned), false);

  const active = await running(repository, kept.id);
  for (const evicted of [historic.id, abandoned]) {
    await assert.rejects(repository.getAttachment(evicted), { code: 'not_found' });
    await assert.rejects(repository.createTask({ ...reference(evicted), provider: 'codex' }), { code: 'not_found' });
    await assert.rejects(repository.continueTask(source, reference(evicted)), { code: 'not_found' });
    await assert.rejects(repository.enqueuePending(active, reference(evicted)), { code: 'not_found' });
    await assert.rejects(repository.claimSteer!(active, reference(evicted)), { code: 'not_found' });
    await assert.rejects(repository.claimSteer!(active, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'see' }, { type: 'attachment', attachmentId: evicted }] }), { code: 'not_found' });
  }
  assert.equal((await repository.createTask({ ...reference(another.id), provider: 'codex' })).created, true);
  assert.equal((await repository.listTasks(0)).items.length, 3);

  await repository.finishTask(active, { exitCode: 0 });
  const again = { ...historic, bytes: 9, sha256: 'b'.repeat(64), createdAt: new Date().toISOString() } as Attachment;
  const revived = await repository.putAttachment(again);
  assert.equal(revived.created, true);
  assert.deepEqual(revived.attachment, again);
  assert.equal(revived.evicted?.length, 1);
  assert.deepEqual(await repository.getAttachment(historic.id), again);
  assert.equal(rows().get(historic.id), 9);
  assert.equal((await repository.continueTask(source, reference(historic.id))).created, true);
  pinnedSchema();
});
