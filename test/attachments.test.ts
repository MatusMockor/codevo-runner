import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, writeFile, readFile, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createAttachmentStore } from '../src/infrastructure/files/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { LIMITS, RunnerError } from '../src/domain/contracts.js';
const hasCode = (code: string) => (error: unknown) => error instanceof RunnerError && error.code === code;
async function* chunks(bytes: Uint8Array) { yield bytes; }
const signal = () => new AbortController().signal;
const png = () => sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-attachments-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(dir, runnerId);
  const store = await createAttachmentStore(dir, runnerId, repository);
  t.after(async () => { await store.close(); await repository.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runnerId, repository, store };
}

test('attachment original bytes persist, retry is idempotent, conflict preserves prior file', async t => {
  const { store, dir, runnerId, repository } = await fixture(t);
  const id = randomUUID();
  const bytes = await png();
  const first = await store.upload(id, 'screen.png', 'image/png', chunks(bytes), signal());
  assert.equal(first.created, true);
  assert.equal(first.attachment.width, 2);
  assert.equal(first.attachment.height, 3);
  assert.equal((await store.upload(id, 'screen.png', 'image/png', chunks(bytes), signal())).created, false);
  await assert.rejects(store.upload(id, 'other.png', 'image/png', chunks(bytes), signal()), hasCode('conflict'));
  assert.deepEqual(Buffer.from((await store.read(id)).bytes), bytes);
  await store.close();
  const reopened = await createAttachmentStore(dir, runnerId, repository);
  try { assert.deepEqual(Buffer.from((await reopened.read(id)).bytes), bytes); } finally { await reopened.close(); }
});

test('invalid, oversized and truncated uploads do not publish metadata or leave files', async t => {
  const { store, dir, repository } = await fixture(t);
  const bytes = await png();
  const id = randomUUID();
  await assert.rejects(store.upload(id, '../a.png', 'image/png', chunks(bytes), signal()), hasCode('invalid_input'));
  await assert.rejects(store.upload(id, 'a.jpg', 'image/jpeg', chunks(bytes), signal()), hasCode('unsupported_media'));
  await assert.rejects(store.upload(id, 'a.png', 'image/png', chunks(bytes.subarray(0, 45)), signal()), hasCode('unsupported_media'));
  await assert.rejects(store.upload(id, 'a.png', 'image/png', chunks(Buffer.alloc(LIMITS.attachmentBytes + 1)), signal()), hasCode('too_large'));
  await assert.rejects(repository.getAttachment(id), hasCode('not_found'));
  assert.deepEqual(await readdir(join(dir, 'attachments')), []);
});

test('concurrent upload admission and shutdown abort a stalled source', async t => {
  const { store, dir } = await fixture(t);
  async function* stalled() { await new Promise(() => undefined); yield Buffer.alloc(0); }
  const id = randomUUID();
  const first = store.upload(id, 'a.png', 'image/png', stalled(), signal());
  const firstRejected = assert.rejects(first, hasCode('storage_unavailable'));
  await assert.rejects(store.upload(id, 'a.png', 'image/png', chunks(await png()), signal()), hasCode('busy'));
  const second = store.upload(randomUUID(), 'b.png', 'image/png', stalled(), signal());
  const secondRejected = assert.rejects(second, hasCode('storage_unavailable'));
  await assert.rejects(store.upload(randomUUID(), 'c.png', 'image/png', chunks(await png()), signal()), hasCode('busy'));
  await store.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(await readdir(join(dir, 'attachments')), []);
});

test('startup removes orphan and staging files but preserves committed files; reads detect corruption', async t => {
  const { store, dir, runnerId, repository } = await fixture(t);
  const id = randomUUID();
  await store.upload(id, 'screen.png', 'image/png', chunks(await png()), signal());
  await store.close();
  await writeFile(join(dir, 'attachments', `${randomUUID()}.blob`), 'orphan');
  await writeFile(join(dir, 'attachments', `${randomUUID()}.${randomUUID()}.tmp`), 'staged');
  for (const name of await readdir(join(dir, 'attachments'))) {
    const old = new Date(Date.now() - 120_000);
    await utimes(join(dir, 'attachments', name), old, old);
  }
  const reopened = await createAttachmentStore(dir, runnerId, repository);
  try {
    assert.deepEqual(await readdir(join(dir, 'attachments')), [`${id}.blob`]);
    const path = join(dir, 'attachments', `${id}.blob`);
    const original = await readFile(path);
    original[original.length - 1] = original[original.length - 1]! ^ 1;
    await writeFile(path, original);
    await assert.rejects(reopened.read(id), hasCode('storage_unavailable'));
    await unlink(path);
    await assert.rejects(reopened.read(id), hasCode('storage_unavailable'));
  } finally { await reopened.close(); }
});

test('fresh orphan retries recover matching bytes and never delete conflicting bytes', async t => {
  const { store, dir, runnerId, repository } = await fixture(t);
  await store.close();
  const id = randomUUID();
  const conflictId = randomUUID();
  const bytes = await png();
  const other = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const path = join(dir, 'attachments', `${id}.blob`);
  const conflictPath = join(dir, 'attachments', `${conflictId}.blob`);
  await writeFile(path, bytes);
  await writeFile(conflictPath, other);
  const reopened = await createAttachmentStore(dir, runnerId, repository);
  try {
    const recovered = await reopened.upload(id, 'screen.png', 'image/png', chunks(bytes), signal());
    assert.equal(recovered.created, true);
    assert.deepEqual(Buffer.from((await reopened.read(id)).bytes), bytes);
    await assert.rejects(reopened.upload(conflictId, 'screen.png', 'image/png', chunks(bytes), signal()), hasCode('conflict'));
    assert.deepEqual(await readFile(conflictPath), other);
    await assert.rejects(repository.getAttachment(conflictId), hasCode('not_found'));
  } finally { await reopened.close(); }
});

test('content reads enforce bounded concurrent admission', async t => {
  const { store } = await fixture(t);
  const id = randomUUID();
  await store.upload(id, 'screen.png', 'image/png', chunks(await png()), signal());
  const first = store.read(id);
  const second = store.read(id);
  await assert.rejects(store.read(id), hasCode('busy'));
  await Promise.all([first, second]);
  assert.equal((await store.read(id)).attachment.id, id);
});

test('preflight rejects non-image bytes claimed to be PNG before native decode', async t => {
  const { store, dir } = await fixture(t);
  await assert.rejects(store.upload(randomUUID(), 'screen.png', 'image/png', chunks(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>')), signal()), hasCode('unsupported_media'));
  assert.deepEqual(await readdir(join(dir, 'attachments')), []);
});
