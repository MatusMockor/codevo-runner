import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import type { AttachmentStore } from '../src/application/ports.js';
import { LIMITS, RunnerError, type Attachment } from '../src/domain/contracts.js';
import { createAttachmentStore, type AttachmentStoreOptions } from '../src/infrastructure/files/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const hasCode = (code: string) => (error: unknown) => error instanceof RunnerError && error.code === code;
const signal = () => new AbortController().signal;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function* chunks(...parts: Uint8Array[]) { for (const part of parts) yield part; }

async function fixture(t: test.TestContext, options: AttachmentStoreOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-file-store-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(dir, runnerId);
  const store = await createAttachmentStore(dir, runnerId, repository, options);
  t.after(async () => { await store.close(); await repository.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runnerId, repository, store, blobs: join(dir, 'attachments') };
}

async function staged(directory: string, count: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if ((await readdir(directory)).filter(name => name.endsWith('.tmp')).length === count) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`expected ${count} temporary upload files`);
}

async function collect(store: AttachmentStore, id: string) {
  const content = await store.open(id);
  const received: Uint8Array[] = [];
  try {
    for await (const chunk of content.chunks()) received.push(chunk);
    return { attachment: content.attachment, received, failure: undefined as unknown };
  } catch (failure) {
    return { attachment: content.attachment, received, failure };
  } finally { await content.close(); }
}

test('a file upload stores undecoded bytes under the closed file shape with private permissions', async t => {
  const { store, repository, runnerId, blobs } = await fixture(t);
  const id = randomUUID();
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/> definitely not a PNG\0\xff');
  const first = await store.uploadFile(id, 'fake.png', 'image/png', chunks(bytes.subarray(0, 10), bytes.subarray(10)), signal());
  assert.equal(first.created, true);
  assert.deepEqual(Object.keys(first.attachment).sort(), ['bytes', 'createdAt', 'id', 'kind', 'mediaType', 'name', 'runnerId', 'sha256']);
  assert.deepEqual({ ...first.attachment, createdAt: '' },
    { id, runnerId, name: 'fake.png', bytes: bytes.length, sha256: sha256(bytes), kind: 'file', mediaType: 'image/png', createdAt: '' });
  assert.deepEqual(await repository.getAttachment(id), first.attachment);
  assert.deepEqual(await store.metadata(id), first.attachment);
  assert.deepEqual(await readdir(blobs), [`${id}.blob`]);
  assert.equal((await stat(join(blobs, `${id}.blob`))).mode & 0o7777, 0o600);
  assert.deepEqual(await readFile(join(blobs, `${id}.blob`)), bytes);
  await assert.rejects(store.read(id), hasCode('unsupported_media'));

  const binaryText = randomUUID();
  const invalidText = Buffer.from([0xc3, 0x28, 0x00, 0xff]);
  const text = await store.uploadFile(binaryText, 'notes.txt', 'text/plain', chunks(invalidText), signal());
  assert.equal(text.attachment.kind, 'file');
  assert.equal(text.attachment.mediaType, 'text/plain');
  await assert.rejects(store.upload(randomUUID(), 'notes.txt', 'text/plain', chunks(invalidText), signal()), hasCode('unsupported_media'));
  await assert.rejects(store.upload(randomUUID(), 'fake.png', 'image/png', chunks(bytes), signal()), hasCode('unsupported_media'));

  const replay = await store.uploadFile(id, 'fake.png', 'image/png', chunks(bytes), signal());
  assert.deepEqual(replay, { attachment: first.attachment, created: false });
  await assert.rejects(store.uploadFile(id, 'other.png', 'image/png', chunks(bytes), signal()), hasCode('conflict'));
  await assert.rejects(store.uploadFile(id, 'fake.png', 'application/octet-stream', chunks(bytes), signal()), hasCode('conflict'));
  await assert.rejects(store.uploadFile(id, 'fake.png', 'image/png', chunks(Buffer.concat([bytes, bytes])), signal()), hasCode('conflict'));
  await assert.rejects(store.uploadFile(id, 'fake.png', 'image/png', chunks(Buffer.from(bytes).fill(1, 0, 1)), signal()), hasCode('conflict'));
  assert.deepEqual(await readFile(join(blobs, `${id}.blob`)), bytes);
  assert.deepEqual((await readdir(blobs)).sort(), [`${binaryText}.blob`, `${id}.blob`].sort());
});

test('the same id cannot change between the legacy and the file contract', async t => {
  const { store, blobs } = await fixture(t);
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const asFile = randomUUID();
  const asImage = randomUUID();
  assert.equal((await store.uploadFile(asFile, 'screen.png', 'image/png', chunks(image), signal())).attachment.kind, 'file');
  const legacy = await store.upload(asImage, 'screen.png', 'image/png', chunks(image), signal());
  assert.equal(Object.hasOwn(legacy.attachment, 'kind'), false);
  assert.deepEqual([legacy.attachment.width, legacy.attachment.height], [2, 3]);
  await assert.rejects(store.upload(asFile, 'screen.png', 'image/png', chunks(image), signal()), hasCode('conflict'));
  await assert.rejects(store.uploadFile(asImage, 'screen.png', 'image/png', chunks(image), signal()), hasCode('conflict'));
  assert.equal((await store.metadata(asFile)).kind, 'file');
  assert.equal((await store.metadata(asImage)).kind, undefined);
  assert.equal((await store.upload(asImage, 'screen.png', 'image/png', chunks(image), signal())).created, false);
  assert.deepEqual((await readdir(blobs)).sort(), [`${asFile}.blob`, `${asImage}.blob`].sort());
});

test('file uploads enforce the hard cap while streaming and reject empty or malformed input', async t => {
  const { store, repository, blobs } = await fixture(t);
  const megabyte = Buffer.alloc(1024 * 1024, 7);
  async function* sized(extra: number) {
    for (let index = 0; index < LIMITS.fileAttachmentBytes / megabyte.length; index++) yield megabyte;
    if (extra) yield Buffer.alloc(extra, 7);
  }
  const oversized = randomUUID();
  await assert.rejects(store.uploadFile(oversized, 'big.bin', 'application/octet-stream', sized(1), signal()), hasCode('too_large'));
  await assert.rejects(repository.getAttachment(oversized), hasCode('not_found'));
  assert.deepEqual(await readdir(blobs), []);

  const empty = randomUUID();
  await assert.rejects(store.uploadFile(empty, 'empty.bin', 'application/octet-stream', chunks(), signal()), hasCode('invalid_input'));
  await assert.rejects(store.uploadFile(empty, 'empty.bin', 'application/octet-stream', chunks(Buffer.alloc(0), Buffer.alloc(0)), signal()), hasCode('invalid_input'));
  await assert.rejects(repository.getAttachment(empty), hasCode('not_found'));
  for (const mediaType of ['', 'Application/PDF', 'application/pdf; charset=binary', 'pdf', 'application/x y'])
    await assert.rejects(store.uploadFile(randomUUID(), 'a.pdf', mediaType, chunks(megabyte), signal()), hasCode('unsupported_media'), mediaType);
  for (const name of ['', '  ', '../a.pdf', 'a\\b.pdf', 'a\nb.pdf', 'x'.repeat(256)])
    await assert.rejects(store.uploadFile(randomUUID(), name, 'application/pdf', chunks(megabyte), signal()), hasCode('invalid_input'), JSON.stringify(name));
  await assert.rejects(store.uploadFile('not-an-id', 'a.pdf', 'application/pdf', chunks(megabyte), signal()), hasCode('invalid_input'));
  assert.deepEqual(await readdir(blobs), []);

  const exact = randomUUID();
  const stored = await store.uploadFile(exact, 'exact.bin', 'application/octet-stream', sized(0), signal());
  assert.equal(stored.attachment.bytes, LIMITS.fileAttachmentBytes);
  const hash = createHash('sha256');
  let total = 0;
  let largest = 0;
  const content = await store.open(exact);
  try {
    for await (const chunk of content.chunks()) {
      hash.update(chunk);
      total += chunk.byteLength;
      largest = Math.max(largest, chunk.byteLength);
    }
  } finally { await content.close(); }
  assert.equal(total, LIMITS.fileAttachmentBytes);
  assert.equal(hash.digest('hex'), stored.attachment.sha256);
  assert.ok(largest <= 64 * 1024);
});

test('a stalled, slow, cancelled or shut down file upload leaves no temporary file, blob or row', async t => {
  const { store, repository, blobs } = await fixture(t, { fileUploadIdleTimeoutMs: 250, fileUploadTimeoutMs: 900 });
  async function* stalled() { yield Buffer.from('partial'); await new Promise(() => undefined); }
  async function* trickle() { for (;;) { yield Buffer.from('x'); await new Promise(resolve => setTimeout(resolve, 10)); } }

  const idle = randomUUID();
  let started = Date.now();
  await assert.rejects(store.uploadFile(idle, 'idle.bin', 'application/octet-stream', stalled(), signal()), hasCode('request_timeout'));
  assert.ok(Date.now() - started < 800, 'the idle deadline fires before the total deadline');
  await assert.rejects(repository.getAttachment(idle), hasCode('not_found'));
  assert.deepEqual(await readdir(blobs), []);

  const slow = randomUUID();
  started = Date.now();
  await assert.rejects(store.uploadFile(slow, 'slow.bin', 'application/octet-stream', trickle(), signal()), hasCode('request_timeout'));
  assert.ok(Date.now() - started >= 850, 'a body that keeps arriving is bounded by the total deadline');
  await assert.rejects(repository.getAttachment(slow), hasCode('not_found'));
  assert.deepEqual(await readdir(blobs), []);

  const cancelled = randomUUID();
  const client = new AbortController();
  const aborting = assert.rejects(store.uploadFile(cancelled, 'gone.bin', 'application/octet-stream', stalled(), client.signal), hasCode('storage_unavailable'));
  await staged(blobs, 1);
  client.abort();
  await aborting;
  await assert.rejects(repository.getAttachment(cancelled), hasCode('not_found'));
  assert.deepEqual(await readdir(blobs), []);

  const first = assert.rejects(store.uploadFile(randomUUID(), 'a.bin', 'application/octet-stream', stalled(), signal()), hasCode('storage_unavailable'));
  const second = assert.rejects(store.uploadFile(randomUUID(), 'b.bin', 'application/octet-stream', stalled(), signal()), hasCode('storage_unavailable'));
  await assert.rejects(store.uploadFile(randomUUID(), 'c.bin', 'application/octet-stream', chunks(Buffer.from('c')), signal()), hasCode('busy'));
  await staged(blobs, 2);
  await store.close();
  await Promise.all([first, second]);
  assert.deepEqual(await readdir(blobs), []);
  await assert.rejects(store.uploadFile(randomUUID(), 'd.bin', 'application/octet-stream', chunks(Buffer.from('d')), signal()), hasCode('storage_unavailable'));
});

test('streamed content withholds its final chunk until length and digest are verified', async t => {
  const { store, blobs } = await fixture(t);
  const id = randomUUID();
  const bytes = randomBytes(300 * 1024 + 17);
  const { attachment } = await store.uploadFile(id, 'data.bin', 'application/octet-stream', chunks(bytes), signal());
  const path = join(blobs, `${id}.blob`);
  const intact = await collect(store, id);
  assert.equal(intact.failure, undefined);
  assert.deepEqual(intact.attachment, attachment);
  assert.equal(intact.received.length, 5);
  assert.deepEqual(Buffer.concat(intact.received), bytes);
  assert.equal((await store.uploadFile(id, 'data.bin', 'application/octet-stream', chunks(bytes), signal())).created, false);

  for (const offset of [0, bytes.length - 1]) {
    const corrupted = Buffer.from(bytes);
    corrupted[offset] = corrupted[offset]! ^ 1;
    await writeFile(path, corrupted);
    const result = await collect(store, id);
    assert.ok(hasCode('storage_unavailable')(result.failure), `corruption at ${offset}`);
    assert.equal(result.received.length, 4);
    assert.ok(Buffer.concat(result.received).length < bytes.length);
    await assert.rejects(store.uploadFile(id, 'data.bin', 'application/octet-stream', chunks(bytes), signal()), hasCode('storage_unavailable'));
  }
  await writeFile(path, Buffer.concat([bytes, Buffer.from('x')]));
  await assert.rejects(store.open(id), hasCode('storage_unavailable'));
  await writeFile(path, bytes);
  await truncate(path, bytes.length - 1);
  await assert.rejects(store.open(id), hasCode('storage_unavailable'));
  await unlink(path);
  await assert.rejects(store.open(id), hasCode('storage_unavailable'));
  const outside = join(blobs, '..', 'outside.bin');
  await writeFile(outside, bytes);
  await symlink(outside, path);
  await assert.rejects(store.open(id), hasCode('storage_unavailable'));
  await unlink(path);
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(store.open(randomUUID()), hasCode('not_found'));
  await assert.rejects(store.open('../outside'), hasCode('invalid_input'));

  const content = await store.open(id);
  const iterator = content.chunks()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await store.close();
  await assert.rejects(iterator.next(), hasCode('storage_unavailable'));
  await assert.rejects(store.open(id), hasCode('storage_unavailable'));
});

test('eviction unlinks blobs after the commit, an evicted id reads as unknown and startup reconciles leftovers', async t => {
  let clock = Date.now();
  const { store, repository, runnerId, dir, blobs } = await fixture(t, { now: () => new Date(clock) });
  const hour = 3_600_000;
  const present = clock;
  const referenced = randomUUID();
  const unreferenced = randomUUID();
  clock = present - 3 * hour;
  await store.uploadFile(referenced, 'kept-in-history.pdf', 'application/pdf', chunks(Buffer.from('referenced')), signal());
  const task = await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'attachment', attachmentId: referenced }] });
  await repository.cancelTask(task.task.id);
  clock = present - 2 * hour;
  await store.uploadFile(unreferenced, 'abandoned.bin', 'application/octet-stream', chunks(Buffer.from('unreferenced')), signal());
  const filler = (index: number): Attachment => ({ id: randomUUID(), runnerId, name: `filler-${index}.bin`, kind: 'file', mediaType: 'application/octet-stream',
    bytes: 1, sha256: 'f'.repeat(64), createdAt: new Date(present - hour + index).toISOString() });
  for (let index = 0; index < LIMITS.attachments - 2; index++) await repository.putAttachment(filler(index));
  clock = present;
  assert.deepEqual((await readdir(blobs)).sort(), [`${referenced}.blob`, `${unreferenced}.blob`].sort());

  const newest = randomUUID();
  assert.deepEqual(Object.keys(await store.uploadFile(newest, 'new.bin', 'application/octet-stream', chunks(Buffer.from('new')), signal())).sort(), ['attachment', 'created']);
  assert.deepEqual((await readdir(blobs)).sort(), [`${newest}.blob`, `${unreferenced}.blob`].sort());
  await assert.rejects(store.metadata(referenced), hasCode('not_found'));
  await assert.rejects(store.open(referenced), hasCode('not_found'));
  await assert.rejects(store.read(referenced), hasCode('not_found'));
  await assert.rejects(repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'attachment', attachmentId: referenced }] }), hasCode('not_found'));
  assert.equal((await store.metadata(unreferenced)).id, unreferenced);

  const another = randomUUID();
  await store.uploadFile(another, 'another.bin', 'application/octet-stream', chunks(Buffer.from('another')), signal());
  assert.deepEqual((await readdir(blobs)).sort(), [`${another}.blob`, `${newest}.blob`].sort());
  await assert.rejects(store.metadata(unreferenced), hasCode('not_found'));
  const rows = () => {
    const db = new DatabaseSync(join(dir, 'runner.sqlite'), { readOnly: true });
    try {
      return Object.fromEntries(db.prepare('SELECT id,bytes FROM attachments WHERE id IN (?,?)').all(referenced, unreferenced).map(row => [row['id'], row['bytes']]));
    } finally { db.close(); }
  };
  assert.deepEqual(rows(), { [referenced]: 0 });

  await store.close();
  const stale = new Date(Date.now() - 10 * 60_000);
  for (const id of [referenced, unreferenced]) await writeFile(join(blobs, `${id}.blob`), 'left behind by a failed unlink');
  for (const name of await readdir(blobs)) await utimes(join(blobs, name), stale, stale);
  const reopened = await createAttachmentStore(dir, runnerId, repository, { now: () => new Date(clock) });
  t.after(() => reopened.close());
  assert.deepEqual((await readdir(blobs)).sort(), [`${another}.blob`, `${newest}.blob`].sort());
  assert.equal((await reopened.metadata(newest)).id, newest);
  await assert.rejects(reopened.metadata(referenced), hasCode('not_found'));
  assert.deepEqual(rows(), { [referenced]: 0 });

  const revived = await reopened.uploadFile(referenced, 'kept-in-history.pdf', 'application/pdf', chunks(Buffer.from('uploaded again')), signal());
  assert.equal(revived.created, true);
  assert.equal(revived.attachment.bytes, 'uploaded again'.length);
  assert.deepEqual(Buffer.concat((await collect(reopened, referenced)).received).toString(), 'uploaded again');
  assert.deepEqual(rows(), { [referenced]: 'uploaded again'.length });
  assert.equal((await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'attachment', attachmentId: referenced }] })).created, true);
});

test('an attachment delivered by steering keeps its row and blob while its turn runs and is evicted after the turn ends', async t => {
  let clock = Date.now();
  const present = clock;
  const { store, repository, runnerId, blobs } = await fixture(t, { now: () => new Date(clock) });
  const steered = randomUUID();
  clock = present - 3_600_000;
  await store.uploadFile(steered, 'steered.bin', 'application/octet-stream', chunks(Buffer.from('steered')), signal());
  clock = present;
  const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'run' }] })).task;
  await repository.queueTask(task.id, 'project');
  assert.equal((await repository.claimNextTask())?.id, task.id);
  const claim = await repository.claimSteer!(task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'attachment', attachmentId: steered }] });
  await repository.acceptSteer!(task.id, claim.messageId);
  for (let index = 0; index < LIMITS.attachments - 1; index++) {
    await repository.putAttachment({ id: randomUUID(), runnerId, name: `young-${index}.bin`, kind: 'file', mediaType: 'application/octet-stream',
      bytes: 1, sha256: 'f'.repeat(64), createdAt: new Date(present).toISOString() });
  }
  const incoming = randomUUID();
  await assert.rejects(store.uploadFile(incoming, 'new.bin', 'application/octet-stream', chunks(Buffer.from('new')), signal()), hasCode('quota_exceeded'));
  assert.deepEqual(await readdir(blobs), [`${steered}.blob`]);
  assert.equal((await store.metadata(steered)).id, steered);
  assert.deepEqual(Buffer.concat((await collect(store, steered)).received).toString(), 'steered');
  await repository.finishTask(task.id, { exitCode: 0 });
  assert.equal((await store.uploadFile(incoming, 'new.bin', 'application/octet-stream', chunks(Buffer.from('new')), signal())).created, true);
  assert.deepEqual(await readdir(blobs), [`${incoming}.blob`]);
  await assert.rejects(store.metadata(steered), hasCode('not_found'));
});

test('a symbolic link in place of the attachment directory is refused without touching its target', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-file-store-link-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(dir, runnerId);
  t.after(async () => { await repository.close(); await rm(dir, { recursive: true, force: true }); });
  const target = join(dir, 'elsewhere');
  await mkdir(target);
  const stale = new Date(Date.now() - 10 * 60_000);
  const names = [`${randomUUID()}.blob`, `${randomUUID()}.${randomUUID()}.tmp`, 'unrelated.txt'].sort();
  for (const name of names) {
    await writeFile(join(target, name), 'not ours');
    await utimes(join(target, name), stale, stale);
  }
  await symlink(target, join(dir, 'attachments'));
  await assert.rejects(createAttachmentStore(dir, runnerId, repository), hasCode('storage_unavailable'));
  assert.deepEqual((await readdir(target)).sort(), names);
  assert.equal((await lstat(join(dir, 'attachments'))).isSymbolicLink(), true);
  await unlink(join(dir, 'attachments'));
  await writeFile(join(dir, 'attachments'), 'a file, not a directory');
  await assert.rejects(createAttachmentStore(dir, runnerId, repository), hasCode('storage_unavailable'));
  await unlink(join(dir, 'attachments'));
  const store = await createAttachmentStore(dir, runnerId, repository);
  await store.close();
  assert.equal((await lstat(join(dir, 'attachments'))).isDirectory(), true);
  assert.deepEqual((await readdir(target)).sort(), names);
});
