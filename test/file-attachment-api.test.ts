import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import type { AttachmentStore } from '../src/application/ports.js';
import { TaskService } from '../src/application/task-service.js';
import { LIMITS, type Attachment } from '../src/domain/contracts.js';
import { createAttachmentStore, type AttachmentStoreOptions } from '../src/infrastructure/files/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { createRunnerApplication, type RunnerServices } from '../src/server.js';

const authorization = 'Bearer test';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Reply = Readonly<{ status: number; headers: IncomingHttpHeaders; body: Buffer; complete: boolean }>;

async function start(t: TestContext, options: AttachmentStoreOptions = {}, decorate: (store: AttachmentStore) => AttachmentStore = store => store) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-file-api-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(dir, runnerId);
  const store = await createAttachmentStore(dir, runnerId, repository, options);
  const services: RunnerServices = { tasks: new TaskService(repository), attachments: decorate(store),
    close: async () => { await store.close(); await repository.close(); } };
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'File attachments', capabilities: { taskExecution: false, eventReplay: true } },
    header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const port = (server.address() as AddressInfo).port;
  const connections = () => new Promise<number>(resolve => { server.getConnections((_error, count) => resolve(count)); });
  return { url: `http://127.0.0.1:${port}`, port, dir, runnerId, repository, blobs: join(dir, 'attachments'), connections };
}

const fileHeaders = (name: string, mediaType: string, extra: Record<string, string> = {}) =>
  ({ authorization, 'x-codevo-attachment-kind': 'file', 'content-type': mediaType, 'x-file-name': encodeURIComponent(name), ...extra });

async function put(url: string, id: string, headers: Record<string, string>, body: Buffer<ArrayBuffer>) {
  const response = await fetch(`${url}/v1/attachments/${id}`, { method: 'PUT', headers, body });
  return { status: response.status, json: await response.json() as { attachment: Attachment; created: boolean; error?: string } };
}

function exchange(port: number, path: string, method: string, headers: Record<string, string>, write: (outgoing: ClientRequest) => Promise<void>): Promise<Reply> {
  return new Promise(resolve => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers });
    let answered = false;
    const unanswered = () => { if (!answered) resolve({ status: 0, headers: {}, body: Buffer.alloc(0), complete: false }); };
    outgoing.on('error', unanswered);
    outgoing.on('close', unanswered);
    outgoing.on('response', response => {
      answered = true;
      const chunks: Buffer[] = [];
      response.on('data', chunk => { chunks.push(chunk); });
      response.on('error', () => undefined);
      response.on('close', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete });
        outgoing.destroy();
      });
    });
    void write(outgoing).catch(() => undefined);
  });
}

function written(outgoing: ClientRequest, chunk: Uint8Array): Promise<void> {
  return new Promise(resolve => { outgoing.write(chunk, () => resolve()); });
}

async function eventually(description: string, check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(description);
}

test('file uploads follow the kind header contract and never decode the declared media type', async t => {
  const { url, port, runnerId, blobs } = await start(t);
  const id = randomUUID();
  const name = 'Správa "Q3" (final).pdf';
  const bytes = Buffer.from('%PDF-1.7 not really a document\0\xff');
  const created = await put(url, id, fileHeaders(name, 'application/pdf'), bytes);
  assert.equal(created.status, 201);
  assert.equal(created.json.created, true);
  assert.deepEqual(Object.keys(created.json).sort(), ['attachment', 'created']);
  assert.deepEqual(Object.keys(created.json.attachment).sort(), ['bytes', 'createdAt', 'id', 'kind', 'mediaType', 'name', 'runnerId', 'sha256']);
  assert.deepEqual({ ...created.json.attachment, createdAt: '' },
    { id, runnerId, name, bytes: bytes.length, sha256: sha256(bytes), kind: 'file', mediaType: 'application/pdf', createdAt: '' });
  assert.deepEqual(await put(url, id, fileHeaders(name, 'application/pdf'), bytes), { status: 200, json: { attachment: created.json.attachment, created: false } });
  assert.deepEqual(await put(url, id, fileHeaders(name, 'application/pdf'), Buffer.from('different')), { status: 409, json: { error: 'conflict' } });
  assert.deepEqual(await put(url, id, fileHeaders('other.pdf', 'application/pdf'), bytes), { status: 409, json: { error: 'conflict' } });
  assert.deepEqual(await put(url, id, fileHeaders(name, 'application/octet-stream'), bytes), { status: 409, json: { error: 'conflict' } });
  const metadata = await fetch(`${url}/v1/attachments/${id}`, { headers: { authorization } });
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), created.json.attachment);

  const fakeImage = randomUUID();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>');
  const image = await put(url, fakeImage, fileHeaders('fake.png', 'image/png'), svg);
  assert.equal(image.status, 201);
  assert.deepEqual([image.json.attachment.kind, image.json.attachment.mediaType, image.json.attachment.bytes], ['file', 'image/png', svg.length]);
  assert.equal(Object.hasOwn(image.json.attachment, 'width'), false);
  assert.equal(Object.hasOwn(image.json.attachment, 'height'), false);
  const binaryText = await put(url, randomUUID(), fileHeaders('notes.txt', 'text/plain'), Buffer.from([0xc3, 0x28, 0x00]));
  assert.deepEqual([binaryText.status, binaryText.json.attachment.kind, binaryText.json.attachment.mediaType], [201, 'file', 'text/plain']);

  for (const kind of ['image', 'File', 'text', 'file, file', 'file;q=1'])
    assert.deepEqual(await put(url, randomUUID(), fileHeaders('a.pdf', 'application/pdf', { 'x-codevo-attachment-kind': kind }), bytes), { status: 400, json: { error: 'invalid_input' } }, kind);
  const duplicated = await exchange(port, `/v1/attachments/${randomUUID()}`, 'PUT',
    { authorization, 'content-type': 'application/pdf', 'x-file-name': 'a.pdf', 'content-length': String(bytes.length) }, async outgoing => {
      outgoing.setHeader('x-codevo-attachment-kind', ['file', 'file']);
      outgoing.end(bytes);
    });
  assert.deepEqual([duplicated.status, JSON.parse(duplicated.body.toString())], [400, { error: 'invalid_input' }]);
  for (const mediaType of ['application/pdf; charset=binary', 'Application/PDF', 'pdf', 'application/x y'])
    assert.deepEqual(await put(url, randomUUID(), fileHeaders('a.pdf', mediaType), bytes), { status: 415, json: { error: 'unsupported_media' } }, mediaType);
  const untyped = { authorization, 'x-codevo-attachment-kind': 'file', 'x-file-name': 'a.pdf' };
  assert.deepEqual(await put(url, randomUUID(), untyped, bytes), { status: 415, json: { error: 'unsupported_media' } });
  assert.deepEqual(await put(url, randomUUID(), fileHeaders('a.pdf', 'application/pdf', { 'content-encoding': 'gzip' }), bytes), { status: 415, json: { error: 'unsupported_media' } });
  assert.deepEqual(await put(url, randomUUID(), fileHeaders('a.pdf', 'application/pdf'), Buffer.alloc(0)), { status: 400, json: { error: 'invalid_input' } });
  for (const invalid of ['a/b.pdf', 'a\\b.pdf', ' ', 'a\nb.pdf', 'x'.repeat(256)])
    assert.deepEqual(await put(url, randomUUID(), fileHeaders(invalid, 'application/pdf'), bytes), { status: 400, json: { error: 'invalid_input' } }, JSON.stringify(invalid));
  const unnamed = { authorization, 'x-codevo-attachment-kind': 'file', 'content-type': 'application/pdf' };
  assert.deepEqual(await put(url, randomUUID(), unnamed, bytes), { status: 400, json: { error: 'invalid_input' } });
  assert.equal((await fetch(`${url}/v1/attachments/${randomUUID()}`, { method: 'PUT', headers: { 'x-codevo-attachment-kind': 'file', 'content-type': 'application/pdf', 'x-file-name': 'a.pdf' }, body: bytes })).status, 401);
  assert.equal((await readdir(blobs)).length, 3);
  assert.deepEqual(await readFile(join(blobs, `${fakeImage}.blob`)), svg);
});

test('an empty Content-Encoding header on a file upload is refused and stores nothing', async t => {
  const { url, port, blobs } = await start(t);
  const bytes = Buffer.from('plain bytes');
  for (const encoding of ['', 'identity']) {
    const id = randomUUID();
    const reply = await exchange(port, `/v1/attachments/${id}`, 'PUT',
      fileHeaders('a.bin', 'application/octet-stream', { 'content-encoding': encoding, 'content-length': String(bytes.length) }), async outgoing => { outgoing.end(bytes); });
    assert.deepEqual([reply.status, JSON.parse(reply.body.toString())], [415, { error: 'unsupported_media' }], JSON.stringify(encoding));
    assert.equal((await fetch(`${url}/v1/attachments/${id}`, { headers: { authorization } })).status, 404);
  }
  const raw = randomUUID();
  const response = await new Promise<string>(resolve => {
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', chunk => { received.push(chunk); });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(Buffer.concat(received).toString('latin1')));
    socket.write(`PUT /v1/attachments/${raw} HTTP/1.1\r\nHost: runner\r\nAuthorization: ${authorization}\r\nX-Codevo-Attachment-Kind: file\r\n`
      + `Content-Type: application/octet-stream\r\nX-File-Name: a.bin\r\nContent-Encoding:\r\nContent-Length: ${bytes.length}\r\n\r\n${bytes.toString('latin1')}`);
  });
  assert.match(response, /^HTTP\/1\.1 415 /);
  assert.ok(response.includes('{"error":"unsupported_media"}'));
  assert.equal((await fetch(`${url}/v1/attachments/${raw}`, { headers: { authorization } })).status, 404);
  assert.deepEqual(await readdir(blobs), []);
  assert.equal((await put(url, randomUUID(), fileHeaders('a.bin', 'application/octet-stream'), bytes)).status, 201);
});

test('the file limit is refused from content-length before the body and enforced while streaming without one', async t => {
  const { url, port, blobs } = await start(t);
  const announced = randomUUID();
  const early = await exchange(port, `/v1/attachments/${announced}`, 'PUT',
    fileHeaders('big.bin', 'application/octet-stream', { 'content-length': String(LIMITS.fileAttachmentBytes + 1) }), async outgoing => { outgoing.flushHeaders(); });
  assert.deepEqual([early.status, JSON.parse(early.body.toString())], [413, { error: 'too_large' }]);

  const streamed = randomUUID();
  const megabyte = Buffer.alloc(1024 * 1024, 5);
  const late = await exchange(port, `/v1/attachments/${streamed}`, 'PUT', fileHeaders('big.bin', 'application/octet-stream'), async outgoing => {
    for (let index = 0; index < LIMITS.fileAttachmentBytes / megabyte.length; index++) await written(outgoing, megabyte);
    outgoing.end(Buffer.from([5]));
  });
  assert.deepEqual([late.status, JSON.parse(late.body.toString())], [413, { error: 'too_large' }]);
  await eventually('rejected uploads leave no file behind', async () => (await readdir(blobs)).length === 0);
  for (const id of [announced, streamed]) assert.equal((await fetch(`${url}/v1/attachments/${id}`, { headers: { authorization } })).status, 404);
  const legacy = await exchange(port, `/v1/attachments/${randomUUID()}`, 'PUT',
    { authorization, 'content-type': 'image/png', 'x-file-name': 'big.png', 'content-length': String(LIMITS.attachmentBytes + 1) }, async outgoing => { outgoing.flushHeaders(); });
  assert.deepEqual([legacy.status, JSON.parse(legacy.body.toString())], [413, { error: 'too_large' }]);
});

test('an upload interrupted by the client leaves no temporary file, blob or row and frees its id', async t => {
  const { url, port, blobs } = await start(t);
  const id = randomUUID();
  const bytes = randomBytes(256 * 1024);
  let outgoingRequest: ClientRequest | undefined;
  const interrupted = exchange(port, `/v1/attachments/${id}`, 'PUT', fileHeaders('partial.bin', 'application/octet-stream', { 'content-length': String(bytes.length) }), async outgoing => {
    outgoingRequest = outgoing;
    await written(outgoing, bytes.subarray(0, 100 * 1024));
  });
  await eventually('the upload reaches its temporary file', async () => (await readdir(blobs)).some(name => name.startsWith(id) && name.endsWith('.tmp')));
  outgoingRequest!.destroy();
  assert.equal((await interrupted).status, 0);
  await eventually('the interrupted upload is removed', async () => (await readdir(blobs)).length === 0);
  assert.equal((await fetch(`${url}/v1/attachments/${id}`, { headers: { authorization } })).status, 404);
  assert.equal((await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } })).status, 404);
  await eventually('the upload slot is released', async () => (await put(url, id, fileHeaders('partial.bin', 'application/octet-stream'), bytes)).status === 201);
  assert.deepEqual(await readdir(blobs), [`${id}.blob`]);
});

test('a file body that stops arriving is answered with 408 and cleaned up', async t => {
  const { url, port, blobs } = await start(t, { fileUploadIdleTimeoutMs: 200 });
  const id = randomUUID();
  const started = Date.now();
  const stalled = await exchange(port, `/v1/attachments/${id}`, 'PUT', fileHeaders('stalled.bin', 'application/octet-stream', { 'content-length': '4096' }), async outgoing => {
    await written(outgoing, Buffer.alloc(16, 1));
  });
  assert.deepEqual([stalled.status, JSON.parse(stalled.body.toString())], [408, { error: 'request_timeout' }]);
  assert.ok(Date.now() - started < 10_000);
  await eventually('the stalled upload is removed', async () => (await readdir(blobs)).length === 0);
  assert.equal((await fetch(`${url}/v1/attachments/${id}`, { headers: { authorization } })).status, 404);
  assert.equal((await put(url, id, fileHeaders('stalled.bin', 'application/octet-stream'), Buffer.alloc(4096, 1))).status, 201);
});

test('file content is streamed as an opaque download and never completes for corrupted bytes', async t => {
  const { url, port, blobs } = await start(t);
  const id = randomUUID();
  const name = 'Správa "Q3" (final)*.html';
  const bytes = randomBytes(300 * 1024 + 5);
  assert.equal((await put(url, id, fileHeaders(name, 'text/html'), bytes)).status, 201);
  const content = await exchange(port, `/v1/attachments/${id}/content`, 'GET', { authorization }, async outgoing => { outgoing.end(); });
  assert.equal(content.status, 200);
  assert.equal(content.complete, true);
  assert.deepEqual(content.body, bytes);
  assert.deepEqual({ type: content.headers['content-type'], length: content.headers['content-length'], sniff: content.headers['x-content-type-options'],
    cache: content.headers['cache-control'], disposition: content.headers['content-disposition'] },
  { type: 'application/octet-stream', length: String(bytes.length), sniff: 'nosniff', cache: 'no-store',
    disposition: 'attachment; filename="Spr_va__Q3___final__.html"; filename*=UTF-8\'\'Spr%C3%A1va%20%22Q3%22%20%28final%29%2A.html' });

  const path = join(blobs, `${id}.blob`);
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  await writeFile(path, corrupted);
  const broken = await exchange(port, `/v1/attachments/${id}/content`, 'GET', { authorization }, async outgoing => { outgoing.end(); });
  assert.equal(broken.status, 200);
  assert.equal(broken.complete, false);
  assert.ok(broken.body.length < bytes.length);
  await assert.rejects((await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } })).arrayBuffer());
  await truncate(path, bytes.length - 1);
  const short = await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } });
  assert.deepEqual([short.status, await short.json()], [503, { error: 'storage_unavailable' }]);
  await writeFile(path, bytes);
  assert.deepEqual(Buffer.from(await (await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } })).arrayBuffer()), bytes);

  const small = randomUUID();
  await put(url, small, fileHeaders('small.bin', 'application/octet-stream'), Buffer.from('small file'));
  await writeFile(join(blobs, `${small}.blob`), 'SMALL file');
  const tampered = await fetch(`${url}/v1/attachments/${small}/content`, { headers: { authorization } });
  assert.deepEqual([tampered.status, await tampered.json()], [503, { error: 'storage_unavailable' }]);
  assert.equal((await fetch(`${url}/v1/attachments/${randomUUID()}/content`, { headers: { authorization } })).status, 404);
  assert.equal((await fetch(`${url}/v1/attachments/${id}/content`)).status, 401);
});

test('slow downloads keep the admission limit without reading the whole file for a stalled client', async t => {
  const pulled: number[] = [];
  const { url, port } = await start(t, {}, store => ({
    metadata: id => store.metadata(id), upload: (...args) => store.upload(...args), uploadFile: (...args) => store.uploadFile(...args),
    read: id => store.read(id), close: () => store.close(),
    open: async id => {
      const content = await store.open(id);
      const index = pulled.push(0) - 1;
      return { attachment: content.attachment, close: () => content.close(), chunks: async function* () {
        for await (const chunk of content.chunks()) {
          pulled[index] = pulled[index]! + chunk.byteLength;
          yield chunk;
        }
      } };
    },
  }));
  const id = randomUUID();
  const megabyte = randomBytes(1024 * 1024);
  const total = 40 * megabyte.length;
  const uploaded = await exchange(port, `/v1/attachments/${id}`, 'PUT', fileHeaders('large.bin', 'application/octet-stream', { 'content-length': String(total) }), async outgoing => {
    for (let index = 0; index < 40; index++) await written(outgoing, megabyte);
    outgoing.end();
  });
  assert.equal(uploaded.status, 201);
  const stored = (JSON.parse(uploaded.body.toString()) as { attachment: Attachment }).attachment;
  const stalled: Socket[] = [];
  t.after(() => { for (const socket of stalled) socket.destroy(); });
  for (let index = 0; index < 2; index++) {
    const socket = connect(port, '127.0.0.1');
    stalled.push(socket);
    socket.on('error', () => undefined);
    socket.pause();
    socket.write(`GET /v1/attachments/${id}/content HTTP/1.1\r\nHost: runner\r\nAuthorization: ${authorization}\r\n\r\n`);
  }
  await eventually('both stalled downloads are admitted', async () => pulled.length === 2 && pulled.every(bytes => bytes > 0));
  const busy = await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } });
  assert.deepEqual([busy.status, await busy.json()], [503, { error: 'busy' }]);
  let previous = -1;
  await eventually('stalled downloads stop pulling from disk', async () => {
    await delay(100);
    const current = pulled[0]! + pulled[1]!;
    const stable = current === previous;
    previous = current;
    return stable;
  });
  assert.equal(pulled.length, 2);
  for (const bytes of pulled) assert.ok(bytes < total, `a stalled client pulled ${bytes} of ${total} bytes`);
  for (const socket of stalled) socket.destroy();
  await eventually('admission is released when the stalled clients disconnect', async () => {
    const response = await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } });
    const body = Buffer.from(await response.arrayBuffer());
    return response.status === 200 && body.length === total && sha256(body) === stored.sha256;
  });
});

test('a client that disconnects between chunks releases its download admission', async t => {
  const gates: Array<() => void> = [];
  const { url, port, connections } = await start(t, {}, store => ({
    metadata: id => store.metadata(id), upload: (...args) => store.upload(...args), uploadFile: (...args) => store.uploadFile(...args),
    read: id => store.read(id), close: () => store.close(),
    open: async id => {
      const content = await store.open(id);
      return { attachment: content.attachment, close: () => content.close(), chunks: async function* () {
        let index = 0;
        for await (const chunk of content.chunks()) {
          if (index++ === 1 && gates.length < 3) await new Promise<void>(resolve => { gates.push(resolve); });
          yield chunk;
        }
      } };
    },
  }));
  const id = randomUUID();
  const bytes = randomBytes(400 * 1024);
  assert.equal((await put(url, id, fileHeaders('data.bin', 'application/octet-stream'), bytes)).status, 201);
  for (let round = 1; round <= 3; round++) {
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    const received = new Promise<void>(resolve => { socket.once('data', () => resolve()); });
    socket.write(`GET /v1/attachments/${id}/content HTTP/1.1\r\nHost: runner\r\nAuthorization: ${authorization}\r\n\r\n`);
    await received;
    await eventually('the download waits for its next chunk', async () => gates.length === round);
    socket.destroy();
    await eventually('the server observes the disconnect', async () => await connections() === 0);
    gates[round - 1]!();
  }
  await eventually('every abandoned download released its admission', async () => {
    const response = await fetch(`${url}/v1/attachments/${id}/content`, { headers: { authorization } });
    const body = Buffer.from(await response.arrayBuffer());
    return response.status === 200 && body.equals(bytes);
  });
});

test('an evicted attachment answers 404 on metadata, content and task admission; a full store with nothing evictable answers 429', async t => {
  let clock = Date.now();
  const present = clock;
  const { url, runnerId, repository, blobs } = await start(t, { now: () => new Date(clock) });
  const evicted = randomUUID();
  clock = present - 2 * 3_600_000;
  assert.equal((await put(url, evicted, fileHeaders('old.bin', 'application/octet-stream'), Buffer.from('old'))).status, 201);
  const row = (ageMs: number, index: number): Attachment => ({ id: randomUUID(), runnerId, name: `row-${index}.bin`, kind: 'file', mediaType: 'application/octet-stream',
    bytes: 1, sha256: 'e'.repeat(64), createdAt: new Date(present - ageMs).toISOString() });
  for (let index = 0; index < LIMITS.attachments - 1; index++) await repository.putAttachment(row(0, index));
  clock = present;
  const draft = (attachmentId: string) => fetch(`${url}/v1/tasks`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Read it' }, { type: 'attachment', attachmentId }] }) });
  assert.equal((await fetch(`${url}/v1/attachments/${evicted}`, { headers: { authorization } })).status, 200);

  const incoming = randomUUID();
  const stored = await put(url, incoming, fileHeaders('new.bin', 'application/octet-stream'), Buffer.from('new'));
  assert.equal(stored.status, 201);
  assert.deepEqual(Object.keys(stored.json).sort(), ['attachment', 'created']);
  assert.deepEqual(await readdir(blobs), [`${incoming}.blob`]);
  for (const path of [`/v1/attachments/${evicted}`, `/v1/attachments/${evicted}/content`]) {
    const response = await fetch(`${url}${path}`, { headers: { authorization } });
    assert.deepEqual([response.status, await response.json()], [404, { error: 'not_found' }], path);
  }
  const refused = await draft(evicted);
  assert.deepEqual([refused.status, await refused.json()], [404, { error: 'not_found' }]);
  assert.equal((await draft(incoming)).status, 201);

  const full = randomUUID();
  assert.deepEqual(await put(url, full, fileHeaders('full.bin', 'application/octet-stream'), Buffer.from('full')), { status: 429, json: { error: 'quota_exceeded' } });
  const legacyFull = await fetch(`${url}/v1/attachments/${randomUUID()}`, { method: 'PUT', headers: { authorization, 'content-type': 'text/plain', 'x-file-name': 'note.txt' }, body: Buffer.from('note') });
  assert.deepEqual([legacyFull.status, await legacyFull.json()], [429, { error: 'quota_exceeded' }]);
  assert.deepEqual(await readdir(blobs), [`${incoming}.blob`]);
  assert.equal((await fetch(`${url}/v1/attachments/${full}`, { headers: { authorization } })).status, 404);
  assert.equal((await fetch(`${url}/v1/attachments/${incoming}`, { headers: { authorization } })).status, 200);
});

test('legacy uploads and downloads are unchanged for a client that sends no kind header', async t => {
  const { url, runnerId, blobs } = await start(t);
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const legacy = (name: string, mediaType: string) => ({ authorization, 'content-type': mediaType, 'x-file-name': encodeURIComponent(name) });
  const imageId = randomUUID();
  const image = await put(url, imageId, legacy('screen (1).png', 'image/png'), png);
  assert.equal(image.status, 201);
  assert.deepEqual(Object.keys(image.json.attachment), ['id', 'runnerId', 'name', 'bytes', 'sha256', 'mediaType', 'width', 'height', 'createdAt']);
  assert.deepEqual({ ...image.json.attachment, createdAt: '' },
    { id: imageId, runnerId, name: 'screen (1).png', bytes: png.length, sha256: sha256(png), mediaType: 'image/png', width: 2, height: 3, createdAt: '' });
  assert.deepEqual(await put(url, imageId, legacy('screen (1).png', 'image/png'), png), { status: 200, json: { attachment: image.json.attachment, created: false } });
  const textId = randomUUID();
  const text = await put(url, textId, legacy('Pasted text.txt', 'text/plain'), Buffer.from('pasted\n'));
  assert.equal(text.status, 201);
  assert.deepEqual(Object.keys(text.json.attachment), ['id', 'runnerId', 'name', 'bytes', 'sha256', 'mediaType', 'createdAt']);
  assert.equal(text.json.attachment.mediaType, 'text/plain');

  const download = await fetch(`${url}/v1/attachments/${imageId}/content`, { headers: { authorization } });
  assert.equal(download.status, 200);
  assert.deepEqual({ type: download.headers.get('content-type'), length: download.headers.get('content-length'), sniff: download.headers.get('x-content-type-options'),
    cache: download.headers.get('cache-control'), disposition: download.headers.get('content-disposition') },
  { type: 'image/png', length: String(png.length), sniff: 'nosniff', cache: 'no-store', disposition: 'attachment; filename="image"; filename*=UTF-8\'\'screen%20%281%29.png' });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  const textDownload = await fetch(`${url}/v1/attachments/${textId}/content`, { headers: { authorization } });
  assert.equal(textDownload.headers.get('content-type'), 'text/plain');
  assert.equal(await textDownload.text(), 'pasted\n');

  for (const [mediaType, body] of [['application/pdf', Buffer.from('%PDF')], ['application/octet-stream', png], ['image/gif', png]] as const)
    assert.deepEqual(await put(url, randomUUID(), legacy('a.bin', mediaType), body), { status: 415, json: { error: 'unsupported_media' } }, mediaType);
  assert.deepEqual(await put(url, randomUUID(), legacy('fake.png', 'image/png'), Buffer.from('<svg/>')), { status: 415, json: { error: 'unsupported_media' } });
  assert.deepEqual(await put(url, randomUUID(), legacy('bad.txt', 'text/plain'), Buffer.from([0xc3, 0x28])), { status: 415, json: { error: 'unsupported_media' } });
  assert.deepEqual(await put(url, randomUUID(), legacy('empty.txt', 'text/plain'), Buffer.alloc(0)), { status: 415, json: { error: 'unsupported_media' } });
  assert.deepEqual(await put(url, randomUUID(), legacy('big.txt', 'text/plain'), Buffer.alloc(LIMITS.textAttachmentBytes + 1, 65)), { status: 413, json: { error: 'too_large' } });
  assert.deepEqual((await readdir(blobs)).sort(), [`${imageId}.blob`, `${textId}.blob`].sort());
});
