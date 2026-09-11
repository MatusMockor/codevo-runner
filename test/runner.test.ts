import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadIdentity } from '../src/identity.ts';
import { loadAuthorization } from '../src/auth.ts';
import { createRunnerServer } from '../src/server.ts';
import { readConfig } from '../src/config.ts';

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
    const server = createRunnerServer({ runnerId, name: 'Test runner', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: false } }, authorized);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
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
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
