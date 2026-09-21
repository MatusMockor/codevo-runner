import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, stat, symlink, writeFile, mkdir, realpath } from 'node:fs/promises';
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
  return { dir, store, stager, image, id };
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
