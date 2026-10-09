import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { WebSocket } from 'ws';
import { MAINTENANCE_LEASE_MS } from '../src/application/maintenance-lease.js';
import type { ExecutionRequest, ExecutionResult } from '../src/domain/execution.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { leaseExemption } from '../src/transport/lease-exempt.js';
import { assertUpdaterLease, eventually, ManualClock, updaterIdle, updaterSnapshot, usageProbeStub } from './maintenance-fixture.js';

type Reply = Readonly<{ status: number; body: string; type: string | undefined }>;
type Options = Readonly<{ execution?: boolean; seed?: (dataDir: string, runnerId: string) => Promise<void> }>;
const exec = promisify(execFile);
const token = 'Bearer maintenance-api-token';
const draft = (text: string) => ({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text }] });
const busy = { error: 'busy' };

function open(url: string, method: string, path: string, headers: OutgoingHttpHeaders): Readonly<{ request: ClientRequest; reply: Promise<Reply> }> {
  const request = httpRequest(`${url}${path}`, { method, headers, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    request.once('error', reject);
    request.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: response.headers['content-type'] }));
    });
  });
  return { request, reply };
}

function send(url: string, method: string, path: string, headers: OutgoingHttpHeaders, body?: string): Promise<Reply> {
  const { request, reply } = open(url, method, path, body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) });
  request.end(body);
  return reply;
}

async function fixture(t: TestContext, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-maintenance-api-'));
  const source = join(root, 'source');
  const dataDir = join(root, 'data');
  const runnerId = randomUUID();
  const clock = new ManualClock();
  const held = new Map<string, () => void>();
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'README.md'), 'Maintenance fixture\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
  await options.seed?.(dataDir, runnerId);
  const usage = await usageProbeStub(root, true);
  const execution: RunnerExecutionOptions = { accountUsageCli: { claudeExecutable: usage.executable }, executionConcurrency: 1, projectsRoot: join(root, 'projects'), projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [{ provider: 'claude', supportsAttachments: false, execute: async (request: ExecutionRequest) => {
      const sessionId = request.resumeSessionId ?? randomUUID();
      await request.onSession?.(sessionId);
      const text = request.task.parts.find(part => part.type === 'text');
      if (!text || text.type !== 'text' || text.text !== 'hold') return { exitCode: 0, sessionId };
      return new Promise<ExecutionResult>(resolve => {
        const cancel = () => resolve({ exitCode: null, error: 'cancelled' });
        held.set(request.task.id, () => resolve({ exitCode: 0, sessionId }));
        request.signal.addEventListener('abort', cancel, { once: true });
        if (request.signal.aborted) cancel();
      });
    } }] };
  const services = await openRunnerServices(dataDir, runnerId, options.execution === false ? undefined : execution, undefined, { clock });
  const app = await createRunnerApplication({ runnerId, name: 'Runner under test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === token, services);
  t.after(async () => {
    for (const release of held.values()) release();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const owner = { authorization: token, 'x-codevo-runner-id': runnerId };
  const call = (method: string, path: string, value?: unknown, headers: OutgoingHttpHeaders = owner) => value === undefined
    ? send(url, method, path, headers)
    : send(url, method, path, { ...headers, 'content-type': 'application/json' }, JSON.stringify(value));
  const prepare = (leaseId: string) => call('POST', '/v1/maintenance/prepare', { leaseId });
  const release = (leaseId: string) => call('DELETE', `/v1/maintenance/${leaseId}`);
  const granted = async (leaseId: string) => {
    const reply = await prepare(leaseId);
    assert.equal(reply.status, 200, reply.body);
    return assertUpdaterLease(reply.body, leaseId, runnerId);
  };
  const refused = async (leaseId: string) => {
    const reply = await prepare(leaseId);
    assert.equal(reply.status, 409, reply.body);
    assert.deepEqual(JSON.parse(reply.body), { error: 'conflict' });
    assert.deepEqual(JSON.parse((await call('POST', '/v1/tasks', draft('still admitted'))).body).created, true);
  };
  const json = async (method: string, path: string, value?: unknown) => JSON.parse((await call(method, path, value)).body);
  const idle = () => updaterIdle(updaterSnapshot(dataDir));
  return { root, dataDir, runnerId, clock, held, services, app, usage, url, owner, call, prepare, release, granted, refused, json, idle };
}

test('the updater prepare, renew and release exchange yields a lease its validation accepts', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const discovery = await state.call('GET', '/v1/runner');
  const body = `{"leaseId": "${leaseId}"}`;
  const headers = { 'accept-encoding': 'identity', 'content-type': 'application/json', 'user-agent': 'Python-urllib/3.12',
    authorization: token, 'x-codevo-runner-id': state.runnerId, connection: 'close' };
  const first = await send(state.url, 'POST', '/v1/maintenance/prepare', headers, body);
  assert.equal(first.status, 200, first.body);
  assert.match(first.type ?? '', /^application\/json/);
  assert.equal(assertUpdaterLease(first.body, leaseId, state.runnerId), MAINTENANCE_LEASE_MS);
  state.clock.advance(MAINTENANCE_LEASE_MS - 1);
  const renewed = await send(state.url, 'POST', '/v1/maintenance/prepare', headers, body);
  assert.equal(renewed.status, 200, renewed.body);
  assert.equal(assertUpdaterLease(renewed.body, leaseId, state.runnerId), MAINTENANCE_LEASE_MS);
  state.clock.advance(MAINTENANCE_LEASE_MS - 1);
  assert.equal((await state.call('POST', '/v1/tasks', draft('fenced'))).status, 503);
  assert.deepEqual(JSON.parse((await state.call('GET', '/healthz', undefined, { authorization: token })).body), { status: 'ok' });
  assert.deepEqual(JSON.parse((await state.call('GET', '/v1/runner')).body), JSON.parse(discovery.body));
  assert.equal(discovery.body.includes('aintenance'), false);
  const other = await state.prepare(randomUUID());
  assert.equal(other.status, 409);
  assert.deepEqual(JSON.parse(other.body), { error: 'conflict' });
  const released = await send(state.url, 'DELETE', `/v1/maintenance/${leaseId}`, { 'accept-encoding': 'identity', 'user-agent': 'Python-urllib/3.12',
    authorization: token, 'x-codevo-runner-id': state.runnerId, connection: 'close' });
  assert.equal(released.status, 200, released.body);
  assert.match(released.type ?? '', /^application\/json/);
  assert.deepEqual(JSON.parse(released.body), { leaseId, released: true });
  const again = await state.release(leaseId);
  assert.equal(again.status, 200);
  assert.deepEqual(JSON.parse(again.body), { leaseId, released: false });
  assert.equal((await state.call('POST', '/v1/tasks', draft('open again'))).status, 201);
});

test('maintenance routes require authentication, the exact runner identity and the exact URL', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const prepare = '/v1/maintenance/prepare', lease = `/v1/maintenance/${leaseId}`;
  const body = JSON.stringify({ leaseId });
  const json = { 'content-type': 'application/json' };
  for (const [method, path, payload] of [['POST', prepare, body], ['POST', prepare, '{bad json'], ['DELETE', lease, undefined]] as const) {
    const anonymous = await send(state.url, method, path, json, payload);
    assert.equal(anonymous.status, 401, path);
    assert.deepEqual(JSON.parse(anonymous.body), { error: 'unauthorized' });
    assert.equal((await send(state.url, method, path, { ...json, authorization: 'Bearer wrong', 'x-codevo-runner-id': state.runnerId }, payload)).status, 401, path);
    for (const identity of [undefined, randomUUID()]) {
      const foreign = await send(state.url, method, path, { ...json, authorization: token, ...(identity ? { 'x-codevo-runner-id': identity } : {}) }, payload);
      assert.equal(foreign.status, 409, path);
      assert.deepEqual(JSON.parse(foreign.body), { error: 'runner_identity_mismatch' });
    }
    assert.equal((await send(state.url, method, path, { ...json, ...state.owner, origin: 'https://foreign.invalid' }, payload)).status, 403, path);
  }
  assert.equal((await state.call('POST', '/v1/tasks', draft('not fenced'))).status, 201);
  for (const [method, path, status] of [
    ['GET', prepare, 405], ['DELETE', prepare, 405], ['PUT', prepare, 405], ['POST', lease, 405], ['GET', lease, 405],
    ['POST', `${prepare}?leaseId=${leaseId}`, 404], ['POST', `${prepare}/`, 404], ['DELETE', `${lease}?force=true`, 404], ['DELETE', `${lease}/`, 404],
    ['DELETE', '/v1/maintenance/not-a-lease', 404], ['DELETE', `/v1/maintenance/${leaseId.toUpperCase()}`, 404], ['POST', '/v1/maintenance', 404],
  ] as const) assert.equal((await state.call(method, path)).status, status, `${method} ${path}`);
  const withBody = await state.call('DELETE', lease, { leaseId });
  assert.equal(withBody.status, 400);
  assert.deepEqual(JSON.parse(withBody.body), { error: 'body_not_allowed' });
  await state.granted(leaseId);
  assert.equal((await send(state.url, 'POST', '/v1/tasks', json, JSON.stringify(draft('anonymous')))).status, 401);
  assert.equal((await send(state.url, 'POST', '/v1/tasks', { ...json, authorization: token, 'x-codevo-runner-id': randomUUID() }, JSON.stringify(draft('foreign')))).status, 409);
  assert.equal((await send(state.url, 'DELETE', lease, {})).status, 401);
  assert.equal((await state.call('POST', '/v1/tasks', draft('fenced'))).status, 503);
});

test('prepare rejects malformed bodies without taking the fence', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const post = (headers: OutgoingHttpHeaders, body?: string) => send(state.url, 'POST', '/v1/maintenance/prepare', { ...state.owner, ...headers }, body);
  const json = { 'content-type': 'application/json' };
  for (const [reply, status, error] of [
    [await post({}, JSON.stringify({ leaseId })), 415, 'unsupported_media'],
    [await post({ 'content-type': 'text/plain' }, JSON.stringify({ leaseId })), 415, 'unsupported_media'],
    [await post({ ...json, 'content-encoding': 'gzip' }, JSON.stringify({ leaseId })), 415, 'unsupported_media'],
    [await post(json), 400, 'invalid_input'],
    [await post(json, '{bad json'), 400, 'invalid_input'],
    [await post(json, 'null'), 400, 'invalid_input'],
    [await post(json, '[]'), 400, 'invalid_input'],
    [await post(json, `"${leaseId}"`), 400, 'invalid_input'],
    [await post(json, '{}'), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId: 7 })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId: null })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId: 'lease' })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId: leaseId.toUpperCase() })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId: [leaseId] })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId, force: true })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ lease: leaseId })), 400, 'invalid_input'],
    [await post(json, JSON.stringify({ leaseId, padding: 'x'.repeat(512) })), 413, 'too_large'],
  ] as const) {
    assert.equal(reply.status, status, reply.body);
    assert.deepEqual(JSON.parse(reply.body), { error });
  }
  assert.equal((await state.call('POST', '/v1/tasks', draft('not fenced'))).status, 201);
  await state.granted(leaseId);
});

function classifiedRoutes(app: INestApplication): readonly string[] {
  const routes: string[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const controller of module.controllers.values()) {
      const type = controller.metatype as { prototype: Record<string, unknown> };
      const base = String(Reflect.getMetadata('path', type) ?? '');
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = type.prototype[name];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata('method', handler);
        if (typeof method !== 'number') continue;
        const path = [base, String(Reflect.getMetadata('path', handler) ?? '')].filter(part => part && part !== '/').join('/');
        routes.push(`${RequestMethod[method]} /${path} ${leaseExemption(handler) ?? 'fenced'}`);
      }
    }
  }
  return routes.sort();
}

test('every registered route is fenced unless its handler is explicitly classified as exempt', async t => {
  const state = await fixture(t);
  const routes = classifiedRoutes(state.app);
  assert.deepEqual(routes.filter(route => !route.endsWith(' fenced')), [
    'DELETE /v1/maintenance/:leaseId maintenance',
    'GET /healthz discovery',
    'GET /v1/attachments/:id storage-read',
    'GET /v1/attachments/:id/content storage-read',
    'GET /v1/git-operations/:id storage-read',
    'GET /v1/history/search storage-read',
    'GET /v1/project-clones/:id storage-read',
    'GET /v1/projects storage-read',
    'GET /v1/runner discovery',
    'GET /v1/tasks storage-read',
    'GET /v1/tasks/:id storage-read',
    'GET /v1/tasks/:id/approvals storage-read',
    'GET /v1/tasks/:id/events storage-read',
    'GET /v1/tasks/:id/pending storage-read',
    'GET /v1/tasks/:id/questions storage-read',
    'GET /v1/tasks/:id/thread-metadata storage-read',
    'GET /v1/tasks/:taskId/artifacts storage-read',
    'GET /v1/tasks/:taskId/artifacts/:id/content storage-read',
    'GET /v1/thread-metadata storage-read',
    'POST /v1/maintenance/prepare maintenance',
  ]);
  assert.deepEqual(routes.filter(route => route.startsWith('GET ') && route.endsWith(' fenced')), [
    'GET /v1/account-usage/:provider fenced',
    'GET /v1/projects/:id/repository-identity fenced',
    'GET /v1/projects/:projectId/command-catalog/:provider fenced',
    'GET /v1/projects/:projectId/git/branches fenced',
    'GET /v1/projects/:projectId/git/status fenced',
    'GET /v1/projects/:projectId/mcp-servers/:provider fenced',
    'GET /v1/projects/:projectId/ports fenced',
    'GET /v1/projects/:projectId/surface/capabilities fenced',
    'GET /v1/projects/:projectId/terminals/:id fenced',
    'GET /v1/repositories/hosts fenced',
    'GET /v1/tasks/:id/diff fenced',
    'GET /v1/tasks/:id/files fenced',
    'GET /v1/tasks/:id/git/status fenced',
    'GET /v1/tasks/:id/ports fenced',
    'GET /v1/tasks/:id/resume fenced',
    'GET /v1/tasks/:id/turn-changes fenced',
  ]);
});

test('a held lease refuses every unclassified route with busy while storage reads and the change stream keep working', { timeout: 30_000 }, async t => {
  const state = await fixture(t);
  const leaseId = randomUUID(), other = randomUUID();
  const id = (await state.json('POST', '/v1/tasks', draft('before'))).task.id as string;
  assert.equal((await state.call('POST', `/v1/tasks/${id}/start`, { projectId: 'sample' })).status, 202);
  await eventually(() => state.json('GET', `/v1/tasks/${id}`), task => task.status === 'succeeded', 'seed turn');
  await eventually(() => state.services.execution!.working, working => !working, 'seed settlement');
  const attachment = randomUUID();
  assert.equal((await send(state.url, 'PUT', `/v1/attachments/${attachment}`, { ...state.owner, 'content-type': 'text/plain', 'x-file-name': 'note.txt' }, 'note\n')).status, 201);
  const before = await state.json('GET', '/v1/tasks');
  await state.granted(leaseId);
  const text = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'next' }] };
  const fenced: ReadonlyArray<readonly [string, string, unknown?]> = [
    ['POST', '/v1/tasks', draft('fenced')], ['POST', `/v1/tasks/${id}/start`, { projectId: 'sample' }], ['POST', `/v1/tasks/${id}/cancel`],
    ['POST', `/v1/tasks/${id}/continue`, text], ['POST', `/v1/tasks/${id}/steer`, text], ['POST', `/v1/tasks/${id}/pending`, text],
    ['POST', `/v1/tasks/${id}/pending/resume`], ['POST', `/v1/tasks/${id}/pending/${other}/steer`], ['DELETE', `/v1/tasks/${id}/pending/${other}`],
    ['POST', `/v1/tasks/${id}/file-diff`, { path: 'README.md' }], ['POST', `/v1/tasks/${id}/turn-file-diff`, { relativePath: 'README.md' }],
    ['POST', `/v1/tasks/${id}/artifacts`, { path: 'README.md' }], ['POST', `/v1/tasks/${id}/questions/${other}/answer`, {}],
    ['POST', `/v1/tasks/${id}/approvals/${other}/answer`, {}], ['PATCH', `/v1/tasks/${id}/thread-metadata`, { title: 'Renamed' }],
    ['POST', `/v1/tasks/${id}/thread-order`, {}], ['POST', `/v1/tasks/${id}/git/commit`, { message: 'Commit' }],
    ['POST', `/v1/tasks/${id}/git/push`, { idempotencyKey: randomUUID(), target: 'thread-branch' }],
    ['POST', '/v1/projects/sample/git/fetch', { idempotencyKey: randomUUID() }], ['POST', '/v1/projects/sample/git/update', { idempotencyKey: randomUUID() }],
    ['POST', '/v1/projects/clone', { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name: 'project' }],
    ['POST', `/v1/project-clones/${other}/cancel`], ['POST', '/v1/project-directories', { path: '/' }],
    ['POST', '/v1/repositories/lookup', { query: 'owner/project' }], ['POST', '/v1/repositories/search', { query: 'project' }],
    ['POST', '/v1/projects/sample/surface/write', { path: 'README.md', text: 'changed\n' }], ['POST', '/v1/projects/sample/surface/read', { path: 'README.md' }],
    ['POST', '/v1/projects/sample/terminals', { cols: 80, rows: 24 }], ['POST', `/v1/projects/sample/terminals/${other}/input`, { data: 'ls\r' }],
    ['POST', `/v1/projects/sample/terminals/${other}/resize`, { cols: 80, rows: 24 }], ['DELETE', `/v1/projects/sample/terminals/${other}`],
    ['GET', `/v1/tasks/${id}/resume`], ['GET', `/v1/tasks/${id}/diff`], ['GET', `/v1/tasks/${id}/files`], ['GET', `/v1/tasks/${id}/turn-changes`],
    ['GET', `/v1/tasks/${id}/git/status`], ['GET', `/v1/tasks/${id}/ports`], ['GET', '/v1/projects/sample/git/status'], ['GET', '/v1/projects/sample/git/branches'],
    ['GET', '/v1/projects/sample/ports'], ['GET', '/v1/projects/sample/repository-identity'], ['GET', '/v1/projects/sample/command-catalog/claude'],
    ['GET', '/v1/projects/sample/mcp-servers/claude'], ['GET', '/v1/projects/sample/surface/capabilities'], ['GET', `/v1/projects/sample/terminals/${other}`],
    ['GET', '/v1/account-usage/claude'], ['GET', '/v1/account-usage/codex'], ['GET', '/v1/repositories/hosts'],
  ];
  for (const [method, path, value] of fenced) {
    const reply = await state.call(method, path, value);
    assert.equal(reply.status, 503, `${method} ${path} ${reply.body}`);
    assert.deepEqual(JSON.parse(reply.body), busy, `${method} ${path}`);
  }
  assert.equal(await state.usage.launched(), 0);
  const upload = await send(state.url, 'PUT', `/v1/attachments/${other}`, { ...state.owner, 'content-type': 'text/plain', 'x-file-name': 'note.txt' }, 'note\n');
  assert.equal(upload.status, 503);
  assert.deepEqual(JSON.parse(upload.body), busy);
  const reads: ReadonlyArray<readonly [string, number]> = [
    ['/healthz', 200], ['/v1/runner', 200], ['/v1/tasks', 200], ['/v1/tasks?after=0', 200], [`/v1/tasks/${id}`, 200],
    [`/v1/tasks/${id}/events`, 200], [`/v1/tasks/${id}/events?after=0`, 200], [`/v1/tasks/${id}/events?before=1000000`, 200],
    [`/v1/tasks/${id}/pending`, 200], [`/v1/tasks/${id}/questions`, 200], [`/v1/tasks/${id}/approvals`, 200], [`/v1/tasks/${id}/artifacts`, 200],
    [`/v1/tasks/${id}/artifacts/${other}/content`, 404], ['/v1/thread-metadata', 200], [`/v1/tasks/${id}/thread-metadata`, 200],
    [`/v1/attachments/${attachment}`, 200], [`/v1/attachments/${attachment}/content`, 200], [`/v1/attachments/${other}`, 404],
    ['/v1/projects', 200], ['/v1/history/search?q=before', 200], [`/v1/project-clones/${other}`, 404], [`/v1/git-operations/${other}`, 404],
  ];
  for (const [path, status] of reads) assert.equal((await state.call('GET', path)).status, status, path);
  assert.equal(JSON.parse((await state.call('GET', `/v1/tasks/${id}/events?before=1000000`)).body).items.length > 0, true);
  assert.deepEqual(await state.json('GET', '/v1/tasks'), before);
  const stream = new WebSocket(`${state.url.replace('http', 'ws')}/v1/changes`, { headers: state.owner });
  const [snapshot] = await once(stream, 'message');
  stream.terminate();
  assert.equal(JSON.parse(String(snapshot)).type, 'snapshot');
  assert.deepEqual(JSON.parse((await state.release(leaseId)).body), { leaseId, released: true });
  assert.equal((await state.call('POST', '/v1/tasks', draft('after release'))).status, 201);
  assert.equal((await state.call('GET', `/v1/tasks/${id}/resume`)).status, 200);
  assert.equal((await state.call('GET', '/v1/projects/sample/git/status')).status, 200);
  await state.granted(other);
  assert.equal((await state.call('POST', '/v1/tasks', draft('fenced again'))).status, 503);
  state.clock.advance(MAINTENANCE_LEASE_MS - 1);
  assert.equal((await state.call('GET', `/v1/tasks/${id}/resume`)).status, 503);
  state.clock.advance(1);
  assert.equal((await state.call('POST', '/v1/tasks', draft('after expiry'))).status, 201);
  assert.equal((await state.call('GET', `/v1/tasks/${id}/resume`)).status, 200);
  assert.deepEqual(JSON.parse((await state.release(other)).body), { leaseId: other, released: false });
  await state.granted(leaseId);
});

test('a process-spawning read in flight blocks the grant through every later spawn and is refused while a lease is held', { timeout: 30_000 }, async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const reading = open(state.url, 'GET', '/v1/account-usage/claude', state.owner);
  reading.request.end();
  await eventually(() => state.usage.launched(), launched => launched === 1, 'first provider process');
  await state.refused(leaseId);
  await state.usage.release(1);
  await eventually(() => state.usage.launched(), launched => launched === 2, 'second provider process');
  await state.refused(leaseId);
  await state.usage.release(2);
  await state.usage.release(3);
  const reply = await reading.reply;
  assert.equal(reply.status, 200, reply.body);
  assert.equal(await state.usage.launched(), 3);
  await state.granted(leaseId);
  const fenced = await state.call('GET', '/v1/account-usage/claude');
  assert.equal(fenced.status, 503);
  assert.deepEqual(JSON.parse(fenced.body), busy);
  assert.equal(await state.usage.launched(), 3);
  assert.deepEqual(JSON.parse((await state.release(leaseId)).body), { leaseId, released: true });
  const admitted = open(state.url, 'GET', '/v1/account-usage/claude', state.owner);
  admitted.request.end();
  await eventually(() => state.usage.launched(), launched => launched === 4, 'provider process after release');
  await state.refused(leaseId);
  for (const step of [4, 5, 6]) await state.usage.release(step);
  assert.equal((await admitted.reply).status, 200);
  await state.granted(leaseId);
});

test('a mutating request in flight blocks the grant until its handler settles, including an aborted upload', { timeout: 30_000 }, async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const staged = async (id: string) => (await readdir(join(state.dataDir, 'attachments'))).some(name => name.startsWith(id) && name.endsWith('.tmp'));
  const begin = async () => {
    const id = randomUUID();
    const upload = open(state.url, 'PUT', `/v1/attachments/${id}`, { ...state.owner, 'content-type': 'text/plain', 'x-file-name': 'note.txt', 'transfer-encoding': 'chunked' });
    upload.request.write('first half ');
    await eventually(() => staged(id), Boolean, 'upload admission');
    return upload;
  };
  const completed = await begin();
  await state.refused(leaseId);
  completed.request.end('second half\n');
  assert.equal((await completed.reply).status, 201);
  const aborted = await begin();
  await state.refused(leaseId);
  aborted.request.destroy(new Error('aborted by test'));
  await assert.rejects(aborted.reply);
  const reply = await eventually(() => state.prepare(leaseId), value => value.status === 200, 'grant after aborted upload');
  assertUpdaterLease(reply.body, leaseId, state.runnerId);
  assert.equal((await state.call('POST', '/v1/tasks', draft('fenced'))).status, 503);
});

test('running and queued tasks and a queued pending message block the grant exactly like the updater snapshot', { timeout: 30_000 }, async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const execution = state.services.execution!;
  const status = async (id: string) => (await state.json('GET', `/v1/tasks/${id}`)).status as string;
  const first = (await state.json('POST', '/v1/tasks', draft('hold'))).task.id as string;
  assert.equal((await state.call('POST', `/v1/tasks/${first}/start`, { projectId: 'sample' })).status, 202);
  await eventually(() => state.held.has(first), Boolean, 'held turn');
  assert.equal(await status(first), 'running');
  assert.equal(state.idle(), false);
  await state.refused(leaseId);
  const second = (await state.json('POST', '/v1/tasks', draft('queued'))).task.id as string;
  assert.equal((await state.call('POST', `/v1/tasks/${second}/start`, { projectId: 'sample' })).status, 202);
  assert.equal(await status(second), 'queued');
  await state.refused(leaseId);
  const pending = await state.call('POST', `/v1/tasks/${first}/pending`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'later' }] });
  assert.equal(pending.status, 202, pending.body);
  assert.equal((await state.call('POST', `/v1/tasks/${second}/cancel`)).status, 200);
  assert.equal((await state.call('POST', `/v1/tasks/${first}/cancel`)).status, 200);
  await eventually(() => execution.working, working => !working, 'execution settlement');
  assert.deepEqual(updaterSnapshot(state.dataDir).pending, 1);
  assert.equal(state.idle(), false);
  await state.refused(leaseId);
  assert.equal((await state.call('DELETE', `/v1/tasks/${first}/pending/${JSON.parse(pending.body).pending.id}`)).status, 200);
  assert.equal(state.idle(), true);
  await state.granted(leaseId);
  const before = updaterSnapshot(state.dataDir);
  await state.granted(leaseId);
  assert.deepEqual(updaterSnapshot(state.dataDir), before);
});

test('a queued task left in storage blocks the grant on a runner without execution', async t => {
  let queued = '';
  const state = await fixture(t, { execution: false, seed: async (dataDir, runnerId) => {
    const repository = await openSqliteRepository(dataDir, runnerId);
    try {
      const { task } = await repository.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'queued' }] });
      queued = (await repository.queueTask(task.id, 'sample')).id;
    } finally { await repository.close(); }
  } });
  const leaseId = randomUUID();
  assert.equal((await state.json('GET', `/v1/tasks/${queued}`)).status, 'queued');
  assert.equal(state.idle(), false);
  const reply = await state.prepare(leaseId);
  assert.equal(reply.status, 409);
  assert.deepEqual(JSON.parse(reply.body), { error: 'conflict' });
  assert.equal((await state.call('POST', `/v1/tasks/${queued}/cancel`)).status, 200);
  assert.equal(state.idle(), true);
  await state.granted(leaseId);
});

test('running and queued clones block the grant until the clone worker is idle', { timeout: 30_000 }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'runner-maintenance-ssh-'));
  const previousPath = process.env.PATH, previousDir = process.env.CODEVO_TEST_MAINTENANCE_DIR;
  t.after(async () => {
    await writeFile(join(bin, 'release'), '');
    if (previousPath === undefined) delete process.env.PATH;
    if (previousPath !== undefined) process.env.PATH = previousPath;
    if (previousDir === undefined) delete process.env.CODEVO_TEST_MAINTENANCE_DIR;
    if (previousDir !== undefined) process.env.CODEVO_TEST_MAINTENANCE_DIR = previousDir;
    await rm(bin, { recursive: true, force: true });
  });
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\ntouch "$CODEVO_TEST_MAINTENANCE_DIR/started"\nwhile [ ! -e "$CODEVO_TEST_MAINTENANCE_DIR/release" ]; do sleep 0.05; done\nexec git-upload-pack "$(cat "$CODEVO_TEST_MAINTENANCE_DIR/repository")"\n', { mode: 0o700 });
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.CODEVO_TEST_MAINTENANCE_DIR = bin;
  const state = await fixture(t);
  await writeFile(join(bin, 'repository'), join(state.root, 'source'));
  const leaseId = randomUUID();
  const clone = (name: string) => state.json('POST', '/v1/projects/clone', { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name });
  const running = await clone('first');
  await eventually(() => readFile(join(bin, 'started'), 'utf8').then(() => true, () => false), Boolean, 'clone transport');
  assert.equal((await state.json('GET', `/v1/project-clones/${running.id}`)).status, 'running');
  const queued = await clone('second');
  assert.equal((await state.json('GET', `/v1/project-clones/${queued.id}`)).status, 'queued');
  assert.equal(state.idle(), false);
  await state.refused(leaseId);
  assert.equal((await state.call('POST', `/v1/project-clones/${queued.id}/cancel`)).status, 200);
  await state.refused(leaseId);
  await writeFile(join(bin, 'release'), '');
  await eventually(() => state.json('GET', `/v1/project-clones/${running.id}`), job => job.status === 'succeeded', 'clone completion');
  await eventually(() => state.services.clones!.working, working => !working, 'clone worker settlement');
  assert.equal(state.idle(), true);
  await state.granted(leaseId);
  assert.equal(updaterSnapshot(state.dataDir).managedProjects, 1);
});
