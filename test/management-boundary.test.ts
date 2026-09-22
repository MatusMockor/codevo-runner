import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

test('management endpoints reject unauthenticated, foreign and missing owners before reading bodies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-management-boundary-'));
  const runnerId = randomUUID(), taskId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [] });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Boundary test', capabilities: { taskExecution: false, eventReplay: true } }, value => value === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const routes = [
    [`/v1/tasks/${taskId}/turn-changes`, 'GET'], [`/v1/tasks/${taskId}/turn-file-diff`, 'POST'],
    ['/v1/repositories/hosts', 'GET'], ['/v1/repositories/lookup', 'POST'], ['/v1/repositories/search', 'POST'],
    ['/v1/project-directories', 'POST'], ['/v1/thread-metadata', 'GET'], [`/v1/thread-metadata?after=${taskId}`, 'GET'],
    [`/v1/tasks/${taskId}/thread-metadata`, 'GET'], [`/v1/tasks/${taskId}/thread-metadata`, 'PATCH'], [`/v1/tasks/${taskId}/thread-order`, 'POST'],
  ];
  for (const [path, method] of routes) {
    const body = method === 'GET' ? undefined : '{bad json';
    assert.equal((await fetch(`${url}${path}`, { method, body })).status, 401, path);
    for (const identity of [undefined, randomUUID()]) {
      assert.equal((await fetch(`${url}${path}`, { method, body, headers: { authorization: 'Bearer test', ...(identity ? { 'x-codevo-runner-id': identity } : {}) } })).status, 409, path);
    }
    assert.equal((await fetch(`${url}${path}`, { method, body, headers: { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId, origin: 'https://foreign.invalid' } })).status, 403, path);
  }
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  assert.equal((await fetch(`${url}/v1/thread-metadata`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/v1/thread-metadata?after=bad`, { headers })).status, 404);
  assert.equal((await fetch(`${url}/v1/repositories/hosts`, { method: 'DELETE', headers })).status, 405);
  const legacy = await (await fetch(`${url}/v1/runner`, { headers })).json();
  assert.equal('projectManagement' in legacy.capabilities, false);
  assert.equal('threadManagement' in legacy.capabilities, false);
  const modern = await (await fetch(`${url}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'projectManagement,threadManagement' } })).json();
  assert.equal(modern.capabilities.projectManagement, true);
  assert.equal(modern.capabilities.threadManagement, true);
  for (const route of ['/v1/repositories/lookup', '/v1/repositories/search']) {
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(4096) }) });
    assert.equal(response.status, 413, route);
  }
  const directory = await fetch(`${url}/v1/project-directories`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x'.repeat(8192) }) });
  assert.equal(directory.status, 413);
});
