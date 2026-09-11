import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadIdentity } from '../src/identity.js';
import { loadAuthorization } from '../src/auth.js';
import { createRunnerApplication } from '../src/server.js';
import { readConfig } from '../src/config.js';

const token = 'test-token-123456789012345678901234567890';

test('HTTP discovery authenticates, rejects unsafe requests and retains identity after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const authorized = await loadAuthorization(tokenFile);
  let firstId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const runnerId = await loadIdentity(directory);
    if (firstId) assert.equal(runnerId, firstId);
    firstId = runnerId;
    const app = await createRunnerApplication({ runnerId, name: 'Test runner', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: false } }, authorized);
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as Server;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${url}/healthz`);
      assert.deepEqual(await health.json(), { status: 'ok' });
      assert.equal((await fetch(`${url}/v1/runner`)).status, 401);
      assert.equal((await fetch(`${url}/v1/runner`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch(`${url}/v1/runner`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { runnerId, name: 'Test runner', protocolVersion: 1,
        capabilities: { taskExecution: false, eventReplay: false } });
      assert.equal((await fetch(`${url}/v1/runner`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
      assert.equal((await fetch(`${url}/v1/tasks`, { method: 'POST', headers, body: '{}' })).status, 405);
      assert.equal((await fetch(`${url}/unknown`, { headers })).status, 404);
    } finally {
      await app.close();
      assert.equal(server.listening, false);
      assert.equal(server.address(), null);
    }
  }
});

test('concurrent identity initialization converges and corrupted state fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identities = await Promise.all(Array.from({ length: 12 }, () => loadIdentity(directory)));
  assert.equal(new Set(identities).size, 1);
  await writeFile(join(directory, 'identity'), 'broken');
  await assert.rejects(loadIdentity(directory), /invalid/);
  await writeFile(join(directory, 'identity'), identities[0] + '\n'.repeat(100));
  await assert.rejects(loadIdentity(directory), /invalid/);
});

test('invalid or oversized token files fail closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'token');
  for (const value of ['short', 'a'.repeat(1000), 'a'.repeat(32) + '\n'.repeat(300)]) {
    await writeFile(path, value);
    await assert.rejects(loadAuthorization(path), /Token file/);
  }
});

test('configuration rejects missing authentication and invalid endpoints', () => {
  assert.throws(() => readConfig({}), /TOKEN_FILE/);
  for (const port of ['0', '-1', '65536', '3abc'])
    assert.throws(() => readConfig({ CODEVO_TOKEN_FILE: 'token', CODEVO_PORT: port }), /PORT/);
  assert.throws(() => readConfig({ CODEVO_TOKEN_FILE: 'token', CODEVO_HOST: 'invalid' }), /HOST/);
  assert.equal(readConfig({ CODEVO_TOKEN_FILE: 'token' }).host, '127.0.0.1');
});

async function startRunner(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const app = await createRunnerApplication({
    runnerId: await loadIdentity(directory), name: 'Protocol test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: false },
  }, await loadAuthorization(tokenFile));
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}

test('HTTP errors preserve authentication boundaries and security headers', async t => {
  const url = await startRunner(t);
  const authorization = `Bearer ${token}`;
  const cases: Array<{ path: string; headers: Record<string, string>; status: number; error: string }> = [
    { path: '/unknown', headers: {}, status: 401, error: 'unauthorized' },
    { path: '/unknown', headers: { authorization }, status: 404, error: 'not_found' },
    { path: '/healthz', headers: { origin: 'https://example.com' }, status: 403, error: 'origin_not_allowed' },
    { path: '/v1/runner', headers: { origin: 'null', authorization }, status: 403, error: 'origin_not_allowed' },
    { path: '/v1/runner/', headers: { authorization }, status: 404, error: 'not_found' },
    { path: '/v1/runner?extra=1', headers: { authorization }, status: 404, error: 'not_found' },
    { path: '/healthz?extra=1', headers: {}, status: 401, error: 'unauthorized' },
  ];
  for (const entry of cases) {
    const response = await fetch(`${url}${entry.path}`, { headers: entry.headers });
    assert.equal(response.status, entry.status, entry.path);
    assert.deepEqual(await response.json(), { error: entry.error });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-powered-by'), null);
  }
});

test('discovery rejects methods before parsing bodies, including malformed JSON', async t => {
  const url = await startRunner(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await fetch(`${url}/healthz`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'HEAD' ? {} : { body: '{invalid json' }),
    });
    assert.equal(response.status, 405, method);
    if (method === 'HEAD') {
      assert.equal(await response.text(), '');
      continue;
    }
    assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
  }
});

function getWithBody(url: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', headers }, incoming => {
      let responseBody = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { responseBody += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: responseBody }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('GET bodies are rejected before health routing or authentication', async t => {
  const url = await startRunner(t);
  for (const path of ['/healthz', '/v1/runner', '/unknown']) {
    const framings: Array<Record<string, string>> = [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }];
    for (const framing of framings) {
      const response = await getWithBody(`${url}${path}`, framing, '{');
      assert.equal(response.status, 400, path);
      assert.deepEqual(JSON.parse(response.body), { error: 'body_not_allowed' });
    }
  }
  const empty = await getWithBody(`${url}/healthz`, { 'content-length': '0' }, '');
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(empty.body), { status: 'ok' });
});
