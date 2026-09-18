import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer steering-http-test-token';
async function fixture(t: TestContext, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-steering-http-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(root, runnerId, enabled ? { projects: [], providers: [] } : undefined);
  const app = await createRunnerApplication({ runnerId, name: 'Steering test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method, headers: { authorization, ...headers, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { services, request };
}

test('steering HTTP forwards exact task, message and attachment identities and returns acceptance', async t => {
  const { services, request } = await fixture(t);
  assert.ok(services.execution);
  const taskId = randomUUID();
  const messageId = randomUUID();
  const receipt = { taskId, messageId, status: 'accepted' as const };
  const steer = t.mock.method(services.execution, 'steer', async () => receipt);
  const pending = t.mock.method(services.execution, 'steerPending', async () => receipt);
  const input = { idempotencyKey: messageId, parts: [
    { type: 'text', text: 'Send now' }, { type: 'attachment', attachmentId: randomUUID() },
  ] };
  const response = await request(`/v1/tasks/${taskId}/steer`, 'POST', input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), receipt);
  assert.deepEqual(steer.mock.calls[0]!.arguments, [taskId, input]);
  const pendingId = randomUUID();
  const dispatched = await request(`/v1/tasks/${taskId}/pending/${pendingId}/steer`, 'POST');
  assert.equal(dispatched.status, 200);
  assert.deepEqual(await dispatched.json(), receipt);
  assert.deepEqual(pending.mock.calls[0]!.arguments, [taskId, pendingId]);
});

test('steering routes reject unknown methods, query strings, pending bodies and foreign identities', async t => {
  const { services, request } = await fixture(t);
  assert.ok(services.execution);
  const taskId = randomUUID();
  const messageId = randomUUID();
  const direct = `/v1/tasks/${taskId}/steer`;
  const queued = `/v1/tasks/${taskId}/pending/${messageId}/steer`;
  const receipt = { taskId, messageId, status: 'accepted' as const };
  const steer = t.mock.method(services.execution, 'steer', async () => receipt);
  const pending = t.mock.method(services.execution, 'steerPending', async () => receipt);
  for (const path of [direct, queued]) {
    assert.equal((await request(path)).status, 405);
    assert.equal((await request(`${path}?extra=1`, 'POST')).status, 404);
    assert.equal((await request(`${path}/`, 'POST')).status, 404);
    assert.equal((await request(path, 'POST', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request(path, 'POST', undefined, { 'x-codevo-runner-id': randomUUID() })).status, 409);
  }
  assert.equal((await request(queued, 'POST', {})).status, 400);
  assert.equal(steer.mock.calls.length, 0);
  assert.equal(pending.mock.calls.length, 0);
});

test('steering validates closed input before looking up task execution', async t => {
  const { request } = await fixture(t);
  const path = `/v1/tasks/${randomUUID()}/steer`;
  const input = { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Send now' }] };
  for (const injected of [{ provider: 'claude' }, { sessionId: randomUUID() }, { projectId: 'foreign' },
    { instructions: { version: 1, files: [] } }, { launch: {} }, { cwd: '/tmp' }]) {
    const response = await request(path, 'POST', { ...input, ...injected });
    assert.equal(response.status, 400);
  }
});

for (const enabled of [true, false]) {
  test(`steering capability tracks execution availability (${enabled})`, async t => {
    const { request } = await fixture(t, enabled);
    const descriptor = await (await request('/v1/runner')).json();
    assert.equal(descriptor.capabilities.taskSteering, enabled);
    if (!enabled) {
      const id = randomUUID();
      assert.equal((await request(`/v1/tasks/${id}/steer`, 'POST', {})).status, 404);
      assert.equal((await request(`/v1/tasks/${id}/pending/${randomUUID()}/steer`, 'POST')).status, 404);
    }
  });
}
