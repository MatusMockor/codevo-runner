import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { loadAuthorization } from '../src/auth.js';
import { loadIdentity } from '../src/identity.js';
import { createRunnerApplication } from '../src/server.js';
import { openRunnerServices } from '../src/runtime.js';
import type { Attachment, Page, Task, TaskEvent } from '../src/domain/contracts.js';

const token = 'durable-test-token-123456789012345678901234567890';
const authorization = `Bearer ${token}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-durable-http-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const authorized = await loadAuthorization(tokenFile);
  const runnerId = await loadIdentity(directory);
  let active: Awaited<ReturnType<typeof createRunnerApplication>> | undefined;
  t.after(async () => {
    await active?.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const services = await openRunnerServices(directory, runnerId);
    active = await createRunnerApplication({
      runnerId, name: 'Durable HTTP test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true },
    }, authorized, services);
    await active.listen(0, '127.0.0.1');
    return `http://127.0.0.1:${(active.getHttpServer().address() as AddressInfo).port}`;
  }
  return {
    directory, runnerId, start,
    stop: async () => { await active?.close(); active = undefined; },
  };
}

function get(url: string, path: string) {
  return fetch(`${url}${path}`, { headers: { authorization } });
}
function post(url: string, path: string, value: unknown) {
  return fetch(`${url}${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}
function upload(url: string, id: string, bytes: Buffer, name = 'screenshot.png', mediaType = 'image/png') {
  return fetch(`${url}/v1/attachments/${id}`, {
    method: 'PUT', headers: { authorization, 'content-type': mediaType, 'x-file-name': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  });
}
async function png(color = '#327ac8') {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: color } }).png().toBuffer();
}
function input(text = 'Check this screenshot') {
  return { idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text }] };
}

test('uploaded screenshot and ordered task history survive application restart without duplicate admission', async t => {
  const state = await fixture(t);
  let url = await state.start();
  const attachmentId = randomUUID();
  const bytes = await png();
  const uploaded = await upload(url, attachmentId, bytes, 'Obrazovka č. 1.png');
  assert.equal(uploaded.status, 201);
  const uploadResult = await uploaded.json() as { attachment: Attachment; created: boolean };
  assert.equal(uploadResult.created, true);
  assert.equal(uploadResult.attachment.runnerId, state.runnerId);
  assert.equal(uploadResult.attachment.name, 'Obrazovka č. 1.png');
  assert.equal(uploadResult.attachment.width, 4);
  assert.equal(uploadResult.attachment.height, 3);
  const command = { ...input(), parts: [
    { type: 'text', text: 'Before image' }, { type: 'attachment', attachmentId }, { type: 'text', text: 'After image' },
  ] };
  const accepted = await post(url, '/v1/tasks', command);
  assert.equal(accepted.status, 201);
  const { task, created } = await accepted.json() as { task: Task; created: boolean };
  assert.equal(created, true);
  assert.equal(task.status, 'draft');
  assert.deepEqual(task.parts, command.parts);
  await state.stop();
  url = await state.start();
  const retryUpload = await upload(url, attachmentId, bytes, 'Obrazovka č. 1.png');
  assert.equal(retryUpload.status, 200);
  assert.equal((await retryUpload.json()).created, false);
  const retried = await post(url, '/v1/tasks', command);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { task, created: false });
  assert.deepEqual(await (await get(url, `/v1/tasks/${task.id}`)).json(), task);
  const listing = await (await get(url, '/v1/tasks')).json() as Page<Task>;
  assert.deepEqual(listing.items, [task]);
  const events = await (await get(url, `/v1/tasks/${task.id}/events`)).json() as Page<TaskEvent>;
  assert.equal(events.items.length, 1);
  assert.equal(events.items[0]?.type, 'task.created');
  const content = await get(url, `/v1/attachments/${attachmentId}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get('content-type') ?? '', /^image\/png/);
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
});

test('conflicting retries and incomplete attachment references cannot create additional tasks', async t => {
  const state = await fixture(t);
  const url = await state.start();
  const command = input();
  assert.equal((await post(url, '/v1/tasks', command)).status, 201);
  assert.equal((await post(url, '/v1/tasks', { ...command, parts: [{ type: 'text', text: 'Different prompt' }] })).status, 409);
  const missing = { ...input(), parts: [{ type: 'attachment', attachmentId: randomUUID() }] };
  const response = await post(url, '/v1/tasks', missing);
  assert.equal(response.status, 404);
  const tasks = await (await get(url, '/v1/tasks')).json() as Page<Task>;
  assert.equal(tasks.items.length, 1);
  assert.equal((await upload(url, missing.parts[0]!.attachmentId, await png())).status, 201);
  assert.equal((await post(url, '/v1/tasks', missing)).status, 201);
  const attachmentId = randomUUID();
  assert.equal((await upload(url, attachmentId, await png())).status, 201);
  assert.equal((await upload(url, attachmentId, await png('#ff0000'))).status, 409);
});

test('cancel is durable and idempotent, and event cursors replay only later events', async t => {
  const state = await fixture(t);
  let url = await state.start();
  const created = await post(url, '/v1/tasks', input());
  const { task } = await created.json() as { task: Task };
  const initial = await (await get(url, `/v1/tasks/${task.id}/events`)).json() as Page<TaskEvent>;
  const cursor = initial.items[0]!.sequence;
  assert.equal((await fetch(`${url}/v1/tasks/${task.id}/cancel`, { method: 'POST', headers: { authorization } })).status, 200);
  assert.equal((await fetch(`${url}/v1/tasks/${task.id}/cancel`, { method: 'POST', headers: { authorization } })).status, 200);
  await state.stop();
  url = await state.start();
  const restored = await (await get(url, `/v1/tasks/${task.id}`)).json() as Task;
  assert.equal(restored.status, 'cancelled');
  const replay = await (await get(url, `/v1/tasks/${task.id}/events?after=${cursor}`)).json() as Page<TaskEvent>;
  assert.equal(replay.items.length, 1);
  assert.equal(replay.items[0]?.type, 'task.cancelled');
  assert.ok(replay.items[0]!.sequence > cursor);
  const empty = await (await get(url, `/v1/tasks/${task.id}/events?after=${replay.items[0]!.sequence}`)).json() as Page<TaskEvent>;
  assert.deepEqual(empty.items, []);
});

test('unauthenticated upload is rejected before storage and cannot be referenced', async t => {
  const state = await fixture(t);
  const url = await state.start();
  const before = (await readdir(state.directory, { recursive: true })).sort();
  const attachmentId = randomUUID();
  const response = await fetch(`${url}/v1/attachments/${attachmentId}`, {
    method: 'PUT', headers: { 'content-type': 'image/png', 'x-file-name': 'screenshot.png' },
    body: new Uint8Array(await png()),
  });
  assert.equal(response.status, 401);
  assert.deepEqual((await readdir(state.directory, { recursive: true })).sort(), before);
  assert.equal((await get(url, `/v1/attachments/${attachmentId}/content`)).status, 404);
});

test('API rejects invalid payloads, unknown fields, invalid cursors and spoofed images', async t => {
  const state = await fixture(t);
  const url = await state.start();
  for (const value of [
    { ...input(), unexpected: true }, { ...input(), provider: 'unknown' },
    { ...input(), parts: [] }, { ...input(), parts: [{ type: 'text', text: 1 }] },
    { ...input(), parts: [{ type: 'text', text: 'Valid', unexpected: true }] },
    { ...input(), idempotencyKey: 'not-a-uuid' },
  ]) {
    assert.equal((await post(url, '/v1/tasks', value)).status, 400, JSON.stringify(value));
  }
  for (const query of ['after=-1', 'after=1.5', 'after=abc', 'after=9007199254740992']) {
    assert.equal((await get(url, `/v1/tasks?${query}`)).status, 400, query);
  }
  for (const query of ['extra=1', 'after=1&after=2']) {
    assert.equal((await get(url, `/v1/tasks?${query}`)).status, 404, query);
  }
  const spoofed = await upload(url, randomUUID(), Buffer.from('not an image'));
  assert.ok([400, 415].includes(spoofed.status));
  assert.equal((await upload(url, randomUUID(), await png(), 'image.svg', 'image/svg+xml')).status, 415);
  assert.equal((await upload(url, randomUUID(), await png(), '../outside.png')).status, 400);
  const tasks = await (await get(url, '/v1/tasks')).json() as Page<Task>;
  assert.deepEqual(tasks.items, []);
});

test('task pagination traverses persisted tasks without omission or duplication', async t => {
  const state = await fixture(t);
  const url = await state.start();
  const ids: string[] = [];
  for (let i = 0; i < 53; i++) {
    const response = await post(url, '/v1/tasks', input(`Task ${i}`));
    assert.equal(response.status, 201);
    ids.push(((await response.json()) as { task: Task }).task.id);
  }
  const first = await (await get(url, '/v1/tasks')).json() as Page<Task>;
  assert.equal(first.items.length, 50);
  assert.notEqual(first.nextCursor, null);
  const second = await (await get(url, `/v1/tasks?after=${first.nextCursor}`)).json() as Page<Task>;
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items].map(task => task.id), ids);
});


test('slow attachment downloads retain admission slots until clients disconnect', { timeout: 15_000 }, async t => {
  const state = await fixture(t);
  const url = await state.start();
  const attachmentId = randomUUID();
  // Incompressible pixels make the response exceed socket buffers while remaining
  // below the upload and decoded-image limits. Paused clients exert real backpressure.
  const bytes = await sharp(randomBytes(1536 * 1536 * 3), {
    raw: { width: 1536, height: 1536, channels: 3 },
  }).png().toBuffer();
  assert.ok(bytes.length > 6 * 1024 * 1024 && bytes.length < 8 * 1024 * 1024);
  assert.equal((await upload(url, attachmentId, bytes)).status, 201);
  const contentUrl = `${url}/v1/attachments/${attachmentId}/content`;
  const clients: IncomingMessage[] = [];
  async function pausedDownload() {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpGet(contentUrl, {
        headers: { authorization }, agent: false,
      }, incoming => {
        incoming.pause();
        incoming.on('error', () => {});
        clients.push(incoming);
        resolve(incoming);
      });
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Paused download timed out')));
      outgoing.on('error', reject);
    });
  }
  try {
    assert.equal((await pausedDownload()).statusCode, 200);
    assert.equal((await pausedDownload()).statusCode, 200);
    const rejected = await fetch(contentUrl, { headers: { authorization }, signal: AbortSignal.timeout(3000) });
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), { error: 'busy' });
    for (const client of clients) client.destroy();
    const deadline = Date.now() + 3000;
    while (true) {
      const recovered = await fetch(contentUrl, { headers: { authorization }, signal: AbortSignal.timeout(3000) });
      if (recovered.status === 200) {
        assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), bytes);
        break;
      }
      assert.equal(recovered.status, 503);
      await recovered.arrayBuffer();
      assert.ok(Date.now() < deadline, 'Download slots did not recover after disconnect');
      await delay(10);
    }
  } finally {
    for (const client of clients) client.destroy();
  }
});

test('instruction payloads accept bounded JSON expansion and never enter task responses', async t => {
  const state = await fixture(t);
  const url = await state.start();
  const files = Array.from({ length: 8 }, (_, i) => ({ scope: 'project', path: `${i}.md`, content: '\u0001'.repeat(65_536) }));
  const instructions = { version: 1, files };
  const request = { ...input(), instructions };
  const created = await post(url, '/v1/tasks', request);
  assert.equal(created.status, 201);
  const result = await created.json() as { task: Task };
  assert.equal(Object.hasOwn(result.task, 'instructions'), false);
  for (const response of [await get(url, `/v1/tasks/${result.task.id}`), await get(url, '/v1/tasks'), await fetch(`${url}/v1/tasks/${result.task.id}/cancel`, { method: 'POST', headers: { authorization } })]) {
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(await response.json()).includes('instructions'), false);
  }
  assert.equal((await post(url, '/v1/tasks', { ...request, instructions: { version: 1, files: [] } })).status, 409);
  assert.equal((await post(url, '/v1/tasks', { ...input(), instructions: { version: 2, files: [] } })).status, 400);
  assert.equal((await post(url, '/v1/tasks', { ...input(), instructions: { version: 1, files: [...files, { scope: 'project', path: 'extra.md', content: 'x' }] } })).status, 413);
  const descriptor = await (await get(url, '/v1/runner')).json() as { capabilities: { instructionSync: boolean } };
  assert.equal(descriptor.capabilities.instructionSync, false);
});

test('text attachment upload and download retain exact bytes across runner restart', async t => {
  const f = await fixture(t); let url = await f.start();
  const id = randomUUID(); const bytes = Buffer.from('Pasted UTF-8 žluťoučký\n'.repeat(2000));
  const response = await upload(url, id, bytes, 'Pasted text.txt', 'text/plain');
  assert.equal(response.status, 201);
  const { attachment: metadata } = await response.json() as { attachment: Attachment };
  assert.equal(metadata.mediaType, 'text/plain');
  assert.equal(Object.hasOwn(metadata, 'width'), false);
  const bad = await upload(url, randomUUID(), Buffer.from([0xff]), 'bad.txt', 'text/plain');
  assert.equal(bad.status, 415);
  await f.stop(); url = await f.start();
  const content = await get(url, `/v1/attachments/${id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'text/plain');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
});
