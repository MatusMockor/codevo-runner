import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, stat, symlink, writeFile, mkdir, realpath, unlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createAttachmentStore } from '../src/infrastructure/files/index.js';
import { createExecutionAttachmentStager } from '../src/infrastructure/files/execution-attachments.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { RunnerError } from '../src/domain/contracts.js';

const hasCode = (code: string) => (error: unknown) => error instanceof RunnerError && error.code === code;
async function* chunks(bytes: Uint8Array) { yield bytes; }
async function fixture(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'runner-execution-images-')));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(dir, runnerId);
  const store = await createAttachmentStore(dir, runnerId, repository);
  const stager = await createExecutionAttachmentStager(dir, store);
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const id = randomUUID();
  await store.upload(id, 'screenshot.png', 'image/png', chunks(image), new AbortController().signal);
  t.after(async () => { await store.close(); await repository.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runnerId, repository, store, stager, image, id };
}

test('staged screenshots are private task-owned copies and cleanup preserves original uploads', async t => {
  const { dir, store, stager, image, id } = await fixture(t);
  const task = randomUUID();
  const staged = await stager.stage(task, [id]);
  assert.deepEqual(staged.attachments, [{ id, path: join(dir, 'execution-inputs', task, `${id}.png`), mediaType: 'image/png' }]);
  const path = staged.attachments[0]!.path;
  assert.deepEqual(await readFile(path), image);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'execution-inputs', task))).mode & 0o777, 0o700);
  await writeFile(path, 'agent changed its temporary copy');
  assert.deepEqual(Buffer.from((await store.read(id)).bytes), image);
  await staged.cleanup();
  await staged.cleanup();
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
  assert.deepEqual(Buffer.from((await store.read(id)).bytes), image);
});

test('partial staging failure removes copies and rejects missing or corrupted attachments', async t => {
  const { dir, stager, id } = await fixture(t);
  await assert.rejects(stager.stage(randomUUID(), [id, randomUUID()]), hasCode('not_found'));
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
  await writeFile(join(dir, 'attachments', `${id}.blob`), 'corrupted');
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
});

test('staging rejects traversal, excessive and duplicate inputs without creating files', async t => {
  const { dir, stager, id } = await fixture(t);
  await assert.rejects(stager.stage('../outside', [id]), hasCode('invalid_input'));
  await assert.rejects(stager.stage(randomUUID(), ['../outside']), hasCode('invalid_input'));
  await assert.rejects(stager.stage(randomUUID(), Array.from({ length: 9 }, () => randomUUID())), hasCode('too_large'));
  await assert.rejects(stager.stage(randomUUID(), [id, id]), hasCode('invalid_input'));
  const empty = await stager.stage(randomUUID(), []);
  assert.deepEqual(empty.attachments, []);
  await empty.cleanup();
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
});

test('existing execution input directory is never overwritten or removed by another stage', async t => {
  const { dir, stager, id, image } = await fixture(t);
  const task = randomUUID();
  const original = await stager.stage(task, [id]);
  await assert.rejects(stager.stage(task, [id]), hasCode('storage_unavailable'));
  assert.deepEqual(await readFile(original.attachments[0]!.path), image);
  await original.cleanup();
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(dir, 'execution-inputs', task));
  await assert.rejects(stager.stage(task, [id]), hasCode('storage_unavailable'));
  assert.deepEqual(await readdir(outside), []);
});

test('symlinked staging root is rejected at creation and after initialization', async t => {
  const { dir, store, stager, id } = await fixture(t);
  const root = join(dir, 'execution-inputs');
  await rm(root, { recursive: true });
  await symlink(join(dir, 'attachments'), root);
  await assert.rejects(createExecutionAttachmentStager(dir, store), hasCode('storage_unavailable'));
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  assert.deepEqual(await readdir(join(dir, 'attachments')), [`${id}.blob`]);
});

test('text inputs stage as private UTF-8 txt files and cleanup preserves durable upload', async t => {
  const { store, stager } = await fixture(t);
  const id = randomUUID();
  const text = 'Large pasted context\n'.repeat(3000);
  await store.upload(id, 'Pasted text.txt', 'text/plain', chunks(Buffer.from(text)), new AbortController().signal);
  const staged = await stager.stage(randomUUID(), [id]);
  const file = staged.attachments[0]!;
  assert.equal(file.mediaType, 'text/plain');
  assert.ok(file.path.endsWith('.txt'));
  assert.equal(await readFile(file.path, 'utf8'), text);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  await staged.cleanup();
  await assert.rejects(readFile(file.path));
  assert.equal(Buffer.from((await store.read(id)).bytes).toString(), text);
});

test('file inputs stage by a verified streamed copy under a sanitized private name', async t => {
  const { dir, store, stager, image, id: imageId } = await fixture(t);
  const bytes = randomBytes(200 * 1024 + 3);
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['report (final).pdf', 'application/pdf', 'report _final_.pdf'],
    ['.env', 'text/plain', 'env'],
    ['-rf \u0160tvr\u0165ro\u010dn\u00fd \ud83d\ude00.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'rf _tvr_ro_n_ _.xlsx'],
    [`${'n'.repeat(250)}.json`, 'application/json', `${'n'.repeat(95)}.json`],
    ['screenshot.png', 'image/png', 'screenshot.png'],
  ];
  const ids: string[] = [];
  for (const [name, mediaType] of cases) {
    const id = randomUUID();
    ids.push(id);
    await store.uploadFile(id, name, mediaType, chunks(bytes), new AbortController().signal);
  }
  const task = randomUUID();
  const staged = await stager.stage(task, [...ids, imageId]);
  const root = join(dir, 'execution-inputs', task);
  assert.deepEqual(staged.attachments, [
    ...cases.map(([name, mediaType, stagedName], index) => ({ kind: 'file', id: ids[index], path: join(root, ids[index]!, stagedName), mediaType, name, bytes: bytes.length })),
    { id: imageId, path: join(root, `${imageId}.png`), mediaType: 'image/png' },
  ]);
  assert.equal((await stat(root)).mode & 0o7777, 0o700);
  for (const attachment of staged.attachments.slice(0, cases.length)) {
    assert.deepEqual(await readFile(attachment.path), bytes);
    assert.equal((await stat(attachment.path)).mode & 0o7777, 0o600);
    assert.equal((await stat(join(root, attachment.id))).mode & 0o7777, 0o700);
    assert.deepEqual(await readdir(join(root, attachment.id)), [attachment.path.slice(join(root, attachment.id).length + 1)]);
  }
  assert.deepEqual(await readFile(join(root, `${imageId}.png`)), image);
  await writeFile(staged.attachments[0]!.path, 'agent changed its temporary copy');
  const original = await store.open(ids[0]!);
  const hash = createHash('sha256');
  try { for await (const chunk of original.chunks()) hash.update(chunk); } finally { await original.close(); }
  assert.equal(hash.digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  await staged.cleanup();
  await staged.cleanup();
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
  assert.equal((await store.metadata(ids[0]!)).bytes, bytes.length);
});

test('a hostile stored name can never leave the attachment directory', async t => {
  const { dir, runnerId, repository, stager } = await fixture(t);
  const bytes = Buffer.from('hostile name payload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['../../../outside.txt', '_.._.._outside.txt'],
    ['..', 'file'],
    ['/etc/passwd', '_etc_passwd'],
    ['a\\..\\b\u0000c\nd', 'a_.._b_c_d'],
  ];
  for (const [name, stagedName] of cases) {
    const id = randomUUID();
    await repository.putAttachment({ id, runnerId, name, kind: 'file', mediaType: 'application/octet-stream', bytes: bytes.length, sha256, createdAt: new Date().toISOString() });
    await writeFile(join(dir, 'attachments', `${id}.blob`), bytes, { mode: 0o600 });
    const task = randomUUID();
    const staged = await stager.stage(task, [id]);
    assert.equal(staged.attachments[0]!.path, join(dir, 'execution-inputs', task, id, stagedName), JSON.stringify(name));
    assert.deepEqual(await readFile(staged.attachments[0]!.path), bytes);
    await staged.cleanup();
  }
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('outside')), []);
});

test('file staging rejects corrupted, replaced, linked and unknown blobs without leaving a copy', async t => {
  const { dir, store, stager } = await fixture(t);
  const bytes = randomBytes(150 * 1024);
  const id = randomUUID();
  await store.uploadFile(id, 'data.bin', 'application/octet-stream', chunks(bytes), new AbortController().signal);
  const blob = join(dir, 'attachments', `${id}.blob`);
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  await writeFile(blob, corrupted);
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  await writeFile(blob, Buffer.concat([bytes, bytes]));
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  await writeFile(blob, bytes.subarray(0, 10));
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  await unlink(blob);
  const elsewhere = join(dir, 'elsewhere.bin');
  await writeFile(elsewhere, bytes);
  await symlink(elsewhere, blob);
  assert.equal((await lstat(blob)).isSymbolicLink(), true);
  await assert.rejects(stager.stage(randomUUID(), [id]), hasCode('storage_unavailable'));
  await assert.rejects(stager.stage(randomUUID(), [randomUUID()]), hasCode('not_found'));
  assert.deepEqual(await readdir(join(dir, 'execution-inputs')), []);
  await unlink(blob);
  await writeFile(blob, bytes, { mode: 0o600 });
  const task = randomUUID();
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(dir, 'execution-inputs', task));
  await assert.rejects(stager.stage(task, [id]), hasCode('storage_unavailable'));
  assert.deepEqual(await readdir(outside), []);
  await unlink(join(dir, 'execution-inputs', task));
  const staged = await stager.stage(task, [id]);
  assert.deepEqual(await readFile(staged.attachments[0]!.path), bytes);
  await staged.cleanup();
});
