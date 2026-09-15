import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RunnerChanges } from '../src/application/runner-changes.js';
import { RunnerChangeTransport } from '../src/transport/changes.js';
import { openRunnerServices } from '../src/runtime.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { createRunnerApplication } from '../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runnerId = '00000000-0000-4000-8000-000000000001';
const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
async function fixture(t: TestContext) {
  const source = new RunnerChanges();
  const server = createServer();
  const transport = new RunnerChangeTransport(source, runnerId, value => value === headers.authorization);
  transport.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { transport.onModuleDestroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { source, transport, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/changes` };
}
function connect(url: string) {
  const client = new WebSocket(url, { headers });
  const first = once(client, 'message').then(([bytes]) => JSON.parse(String(bytes)));
  return { client, first };
}

test('changes authenticate exact identity, reject origins and unknown paths', async t => {
  const { url } = await fixture(t);
  for (const [path, requestHeaders, status] of [
    [url, {}, 401], [url, { authorization: 'Bearer test' }, 409],
    [url, { ...headers, 'x-codevo-runner-id': 'wrong' }, 409],
    [url, { ...headers, origin: 'https://example.com' }, 400],
    [url + '?after=1', headers, 404],
  ] as const) {
    const client = new WebSocket(path, { headers: requestHeaders });
    client.on('error', () => {});
    const response = await new Promise<number>(resolve => client.once('unexpected-response', (_request, result) => {
      resolve(result.statusCode!); result.resume(); client.terminate();
    }));
    assert.equal(response, status);
  }
});

test('burst coalesces and reconnect snapshot repairs missed invalidations; shutdown closes owners', async t => {
  const { source, transport, url } = await fixture(t);
  const { client, first } = connect(url);
  const snapshot = await first;
  assert.deepEqual(snapshot, { type: 'snapshot', runnerId, ...source.snapshot() });
  const messages: unknown[] = [];
  client.on('message', data => messages.push(JSON.parse(String(data))));
  const changed = once(client, 'message');
  for (let index = 0; index < 1000; index++) source.publish();
  await changed;
  assert.deepEqual(messages, [{ type: 'changed', runnerId, epoch: snapshot.epoch, revision: 1000 }]);
  const closed = once(client, 'close'); client.terminate(); await closed;
  source.publish();
  const reconnected = connect(url);
  assert.deepEqual(await reconnected.first, { type: 'snapshot', runnerId, epoch: snapshot.epoch, revision: 1001 });
  const shutdown = once(reconnected.client, 'close'); transport.onModuleDestroy(); await shutdown;
  source.publish(); // Removed listener must not schedule new work after shutdown.
});

test('rejects client payloads and bounds clients', async t => {
  const { url } = await fixture(t);
  const clients: WebSocket[] = [];
  for (let index = 0; index < 16; index++) { const item = connect(url); await item.first; clients.push(item.client); }
  const extra = new WebSocket(url, { headers }); extra.on('error', () => {});
  assert.equal(await new Promise<number>(resolve => extra.once('unexpected-response', (_request, response) => {
    resolve(response.statusCode!); response.resume(); extra.terminate();
  })), 503);
  const closed = once(clients[0]!, 'close'); clients[0]!.send('not-supported'); await closed;
  for (const client of clients) client.terminate();
});

test('durable repository publishes changes, reads remain idle, application shutdown cleans websocket', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const services = await openRunnerServices(directory, runnerId);
  const app = await createRunnerApplication({ runnerId, name: 'test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, value => value === headers.authorization, services);
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const item = connect(`ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1/changes`);
  await item.first;
  const revision = services.changes.snapshot().revision;
  await services.tasks.list(0);
  assert.equal(services.changes.snapshot().revision, revision);
  const message = once(item.client, 'message');
  await services.tasks.create({ idempotencyKey: '00000000-0000-4000-8000-000000000002', provider: 'codex', parts: [{ type: 'text', text: 'hello' }] });
  await message;
  assert.ok(services.changes.snapshot().revision > revision);
  const closed = once(item.client, 'close'); await app.close(); await closed;
});


test('throwing observers cannot suppress subsequent listeners or durable operation settlement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-changes-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const changes = new RunnerChanges();
  let observed = 0;
  changes.subscribe(() => { throw new Error('broken observer'); });
  changes.subscribe(() => { observed++; });
  const repository = await openSqliteRepository(directory, runnerId, () => {
    changes.publish();
    throw new Error('broken notification adapter');
  });
  t.after(() => repository.close());
  const input = { idempotencyKey: '00000000-0000-4000-8000-000000000003',
    provider: 'codex' as const, parts: [{ type: 'text' as const, text: 'durable despite observer failure' }] };
  const result = await repository.createTask(input);
  assert.equal(result.created, true);
  assert.equal(observed, 1);
  assert.equal(changes.snapshot().revision, 1);
  assert.deepEqual(await repository.getTask(result.task.id), result.task);
  await repository.cancelTask(result.task.id);
  assert.equal(observed, 2);
});
