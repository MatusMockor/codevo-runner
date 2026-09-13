import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRunnerApplication } from '../src/server.js';
import { openRunnerServices } from '../src/runtime.js';

const authorization = 'Bearer runner-identity-test-token';

async function fixture(t: TestContext, extended = true) {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-runner-identity-'));
  const runnerId = randomUUID();
  const services = extended ? await openRunnerServices(directory, runnerId) : undefined;
  const app = await createRunnerApplication({ runnerId, name: 'Identity test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: false },
  }, header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { url, runnerId };
}

test('pinned runner identity rejects reads and mutations before parsing request bodies', async t => {
  const { url, runnerId } = await fixture(t);
  const valid = { authorization, 'X-Codevo-Runner-Id': runnerId };
  const draft = await fetch(`${url}/v1/tasks`, { method: 'POST', headers: { ...valid, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Draft' }] }) });
  assert.equal(draft.status, 201);
  const task = (await draft.json()).task;
  const attachmentId = randomUUID();
  const headers = { authorization, 'X-Codevo-Runner-Id': randomUUID() };
  for (const [method, path] of [
    ['GET', '/v1/runner'], ['GET', '/v1/tasks'], ['GET', '/v1/projects'],
    ['GET', `/v1/tasks/${task.id}`], ['GET', `/v1/tasks/${task.id}/events`],
    ['POST', '/v1/tasks'], ['POST', `/v1/tasks/${task.id}/start`],
    ['POST', `/v1/tasks/${task.id}/cancel`], ['PUT', `/v1/attachments/${attachmentId}`],
  ]) {
    const response = await fetch(`${url}${path}`, { method, headers,
      ...(method === 'GET' ? {} : { body: '{invalid' }) });
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { error: 'runner_identity_mismatch' });
  }
  const list = await (await fetch(`${url}/v1/tasks`, { headers: valid })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, 'draft');
  assert.equal((await fetch(`${url}/v1/attachments/${attachmentId}`, { headers: valid })).status, 404);
  assert.equal((await fetch(`${url}/v1/tasks`, { headers: { 'X-Codevo-Runner-Id': runnerId } })).status, 401);
});

test('discovery accepts absent or exact identity and rejects mismatches in both runner modes', async t => {
  for (const extended of [false, true]) {
    const { url, runnerId } = await fixture(t, extended);
    const matching: Record<string, string>[] = [{ authorization }, { authorization, 'x-codevo-runner-id': runnerId }];
    for (const headers of matching) {
      const response = await fetch(`${url}/v1/runner`, { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).runnerId, runnerId);
    }
    for (const expected of [randomUUID(), '', `${runnerId}, ${runnerId}`]) {
      const response = await fetch(`${url}/v1/runner`, { headers: { authorization, 'x-codevo-runner-id': expected } });
      assert.equal(response.status, 409);
    }
    assert.equal((await fetch(`${url}/healthz`, { headers: { 'x-codevo-runner-id': 'wrong' } })).status, 200);
  }
});

test('duplicate runner identity headers are rejected even when both values match', async t => {
  const { url, runnerId } = await fixture(t);
  const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const outgoing = request(`${url}/v1/runner`, { headers: [
      'Host', new URL(url).host, 'Authorization', authorization, 'X-Codevo-Runner-Id', runnerId, 'x-codevo-runner-id', runnerId,
    ] }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'duplicate_runner_identity' });
});
