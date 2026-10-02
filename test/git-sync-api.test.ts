import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { readConfig } from '../src/config.js';

type Example = Readonly<{ name: string; value: unknown }>;
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/remote-git-sync-wire.json', import.meta.url), 'utf8')) as
  Readonly<{ sections: Readonly<Record<string, Readonly<{ accepted: readonly Example[]; rejected: readonly Example[] }>>> }>;

function getWithBody(url: string, headers: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', headers: { ...headers, 'content-type': 'application/json', 'content-length': '2' } }, response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on('error', reject);
    outgoing.end('{}');
  });
}

async function runner(t: { after(action: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'runner-git-api-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [] });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Git API', capabilities: { taskExecution: false, eventReplay: true } },
    value => value === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`, runnerId };
}

test('gitSync is announced only to clients that understand it', async t => {
  const { url, runnerId } = await runner(t);
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  const legacy = (await (await fetch(`${url}/v1/runner`, { headers })).json()).capabilities;
  assert.equal('gitSync' in legacy, false);
  assert.equal('portPreview' in legacy, false);
  const modern = (await (await fetch(`${url}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'turnChanges,gitSync,portPreview' } })).json()).capabilities;
  assert.equal(modern.gitSync, true);
  assert.equal(modern.portPreview, process.platform === 'linux');
  assert.deepEqual({ ...modern, gitSync: undefined, portPreview: undefined, turnChanges: undefined }, { ...legacy, gitSync: undefined, portPreview: undefined, turnChanges: undefined });

  const discovery = await createRunnerApplication({ protocolVersion: 1, runnerId: randomUUID(), name: 'Discovery only',
    capabilities: { taskExecution: false, eventReplay: true, gitSync: true, portPreview: true } }, () => true);
  t.after(() => discovery.close());
  await discovery.listen(0, '127.0.0.1');
  const descriptor = await (await fetch(`http://127.0.0.1:${(discovery.getHttpServer().address() as AddressInfo).port}/v1/runner`,
    { headers: { 'x-codevo-client-capabilities': 'gitSync,portPreview' } })).json();
  assert.equal(descriptor.capabilities.gitSync, false);
  assert.equal(descriptor.capabilities.portPreview, false);
});

test('every git route enforces auth, owner identity, method, body and query rules before work', async t => {
  const { url, runnerId } = await runner(t);
  const taskId = randomUUID();
  const routes: ReadonlyArray<readonly [string, 'GET' | 'POST']> = [
    ['/v1/projects/example/git/branches', 'GET'], ['/v1/projects/example/git/status', 'GET'],
    ['/v1/projects/example/git/fetch', 'POST'], ['/v1/projects/example/git/update', 'POST'],
    [`/v1/tasks/${taskId}/git/status`, 'GET'], [`/v1/tasks/${taskId}/git/commit`, 'POST'],
    [`/v1/tasks/${taskId}/git/push`, 'POST'], [`/v1/git-operations/${randomUUID()}`, 'GET'],
  ];
  const owner = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  for (const [path, method] of routes) {
    const body = method === 'POST' ? '{bad json' : undefined;
    assert.equal((await fetch(`${url}${path}`, { method, body })).status, 401, path);
    assert.equal((await fetch(`${url}${path}`, { method, body, headers: { authorization: 'Bearer test' } })).status, 409, path);
    assert.equal((await fetch(`${url}${path}`, { method, body, headers: { authorization: 'Bearer test', 'x-codevo-runner-id': randomUUID() } })).status, 409, path);
    assert.equal((await fetch(`${url}${path}`, { method, body, headers: { ...owner, origin: 'https://foreign.invalid' } })).status, 403, path);
    assert.equal((await fetch(`${url}${path}`, { method: method === 'GET' ? 'DELETE' : 'GET', headers: owner })).status, 405, path);
    assert.equal((await fetch(`${url}${path}?force=1`, { method, body, headers: owner })).status, 404, path);
    if (method === 'GET') {
      assert.equal(await getWithBody(`${url}${path}`, owner), 400, path);
      continue;
    }
    assert.equal((await fetch(`${url}${path}`, { method, body: '{}', headers: owner })).status, 415, path);
    assert.equal((await fetch(`${url}${path}`, { method, body, headers: { ...owner, 'content-type': 'application/json' } })).status, 400, path);
    assert.equal((await fetch(`${url}${path}`, { method, body: JSON.stringify({ message: 'x'.repeat(40_000) }), headers: { ...owner, 'content-type': 'application/json' } })).status, 413, path);
  }
  for (const path of ['/v1/projects/../git/branches', '/v1/projects/-bad/git/status', '/v1/tasks/not-a-uuid/git/status', '/v1/projects/example/git/pull', '/v1/git-operations/1'])
    assert.equal((await fetch(`${url}${path}`, { headers: owner })).status, 404, path);
  const json = { ...owner, 'content-type': 'application/json' };
  const post = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: json, body: JSON.stringify(value) });
  for (const example of fixture.sections.fetchOrUpdateBody!.rejected) {
    assert.equal((await post('/v1/projects/example/git/fetch', example.value)).status, 400, example.name);
    assert.equal((await post('/v1/projects/example/git/update', example.value)).status, 400, example.name);
  }
  for (const example of fixture.sections.commitBody!.rejected)
    assert.equal((await post(`/v1/tasks/${taskId}/git/commit`, example.value)).status, 400, example.name);
  for (const example of fixture.sections.pushBody!.rejected)
    assert.equal((await post(`/v1/tasks/${taskId}/git/push`, example.value)).status, 400, example.name);
  assert.deepEqual(await (await post('/v1/projects/example/git/fetch', { idempotencyKey: randomUUID() })).json(), { error: 'not_found' });
  assert.equal((await post(`/v1/tasks/${taskId}/git/commit`, { message: 'Fix' })).status, 404);
  assert.equal((await fetch(`${url}/v1/git-operations/${randomUUID()}`, { headers: owner })).status, 404);
  assert.equal((await fetch(`${url}/v1/projects/example/git/branches`, { headers: owner })).status, 404);
  const start = await post(`/v1/tasks/${taskId}/start`, { projectId: 'example', base: { kind: 'origin-branch', branch: '+main' } });
  assert.equal(start.status, 400);
});

test('commit identity configuration must be complete, printable and bounded', () => {
  const base = { CODEVO_TOKEN_FILE: 'token' };
  assert.equal(readConfig(base).gitAuthor, undefined);
  assert.deepEqual(readConfig({ ...base, CODEVO_GIT_AUTHOR_NAME: 'Codevo Runner', CODEVO_GIT_AUTHOR_EMAIL: 'runner@example.invalid' }).gitAuthor,
    { name: 'Codevo Runner', email: 'runner@example.invalid' });
  for (const invalid of [{ CODEVO_GIT_AUTHOR_NAME: 'Only name' }, { CODEVO_GIT_AUTHOR_EMAIL: 'only@example.invalid' },
    { CODEVO_GIT_AUTHOR_NAME: 'Bad <name>', CODEVO_GIT_AUTHOR_EMAIL: 'a@example.invalid' },
    { CODEVO_GIT_AUTHOR_NAME: 'Name', CODEVO_GIT_AUTHOR_EMAIL: 'a\n@example.invalid' },
    { CODEVO_GIT_AUTHOR_NAME: ' ', CODEVO_GIT_AUTHOR_EMAIL: 'a@example.invalid' },
    { CODEVO_GIT_AUTHOR_NAME: 'é'.repeat(129), CODEVO_GIT_AUTHOR_EMAIL: 'a@example.invalid' }])
    assert.throws(() => readConfig({ ...base, ...invalid }), /CODEVO_GIT_AUTHOR/);
});
