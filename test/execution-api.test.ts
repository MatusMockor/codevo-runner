import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRunnerApplication } from '../src/server.js';
import { openRunnerServices } from '../src/runtime.js';
import type { Task } from '../src/domain/contracts.js';
import sharp from 'sharp';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';

const authorization = 'Bearer execution-http-test-token';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-execution-http-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(directory, runnerId);
  const app = await createRunnerApplication({
    runnerId, name: 'Execution HTTP test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true },
  }, header => header === authorization, services);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}

function post(url: string, path: string, value: unknown) {
  return fetch(`${url}${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

test('draft-only runner never advertises or admits execution and preserves task drafts', async t => {
  const url = await fixture(t);
  const descriptor = await (await fetch(`${url}/v1/runner`, { headers: { authorization } })).json();
  assert.equal(descriptor.capabilities.taskExecution, false);
  const response = await post(url, '/v1/tasks', {
    idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Inspect project' }],
  });
  assert.equal(response.status, 201);
  const { task } = await response.json() as { task: Task };
  assert.equal((await post(url, `/v1/tasks/${task.id}/start`, { projectId: 'example' })).status, 404);
  for (const path of ['/v1/projects', `/v1/tasks/${task.id}/diff`]) {
    assert.equal((await fetch(`${url}${path}`, { headers: { authorization } })).status, 404);
  }
  const restored = await (await fetch(`${url}/v1/tasks/${task.id}`, { headers: { authorization } })).json();
  assert.equal(restored.status, 'draft');
});

test('execution routes authenticate before handling inputs and reject ambiguous routes', async t => {
  const url = await fixture(t);
  const id = randomUUID();
  for (const path of ['/v1/projects', `/v1/tasks/${id}/diff`, `/v1/tasks/${id}/start`]) {
    const response = await fetch(`${url}${path}`, {
      method: path.endsWith('/start') ? 'POST' : 'GET',
    });
    assert.equal(response.status, 401, path);
  }
  for (const path of ['/v1/projects?path=/etc', `/v1/tasks/${id}/start?projectId=example`, `/v1/tasks/${id}/diff?path=/etc`]) {
    assert.equal((await fetch(`${url}${path}`, { headers: { authorization } })).status, 404, path);
  }
  assert.equal((await fetch(`${url}/v1/tasks/${id}/start`, { headers: { authorization } })).status, 405);
  assert.equal((await post(url, '/v1/projects', {})).status, 405);
});


test('accepted execution survives client disconnect and replays output and diff after reconnect', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-execution-e2e-'));
  const project = join(directory, 'project');
  const dataDir = join(directory, 'runner');
  const executable = join(directory, 'fake-codex');
  await mkdir(project);
  const git = promisify(execFile);
  await git('git', ['init', project]);
  await writeFile(join(project, 'README.md'), 'Original project\n');
  await git('git', ['-C', project, 'add', 'README.md']);
  await git('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial project']);
  // Only the external provider CLI is substituted. HTTP, service, SQLite, Git and
  // process ownership use their production implementations.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  prompt = prompt.split('[User request]\\n').at(-1);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '${randomUUID()}' }));
  if (prompt === 'Wait until cancelled') {
    console.log(JSON.stringify({ type: 'item.completed', text: 'waiting-for-cancel' }));
    setInterval(() => {}, 1000);
    return;
  }
  const imageIndex = process.argv.indexOf('-i');
  if (imageIndex < 0 || fs.readFileSync(process.argv[imageIndex + 1])[0] !== 137) process.exit(7);
  setTimeout(() => {
  fs.appendFileSync('README.md', 'Updated by server agent\\n');
  console.log(JSON.stringify({ type: 'item.completed', prompt }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}, 150);
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  let app: Awaited<ReturnType<typeof createRunnerApplication>> | undefined;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    const services = await openRunnerServices(dataDir, runnerId, {
      projects: [{ id: 'sample', name: 'Sample project', path: project }],
      providers: [new CliProviderExecutor('codex', { executable })],
    });
    app = await createRunnerApplication({ runnerId, name: 'Execution test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    await app.listen(0, '127.0.0.1');
    return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }
  let url = await start();
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const descriptor = await (await get('/v1/runner')).json();
  assert.equal(descriptor.capabilities.taskExecution, true);
  assert.deepEqual(await (await get('/v1/projects')).json(), { items: [{ id: 'sample', name: 'Sample project' }] });
  const attachmentId = randomUUID();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const uploaded = await fetch(`${url}/v1/attachments/${attachmentId}`, {
    method: 'PUT', headers: { authorization, 'content-type': 'image/png', 'x-file-name': 'screenshot.png' },
    body: new Uint8Array(png),
  });
  assert.equal(uploaded.status, 201);
  const created = await post(url, '/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'Update README' }, { type: 'attachment', attachmentId }] });
  const { task } = await created.json() as { task: Task };
  for (const input of [{ projectId: 'sample', cwd: '/etc' }, { projectId: 'sample', command: 'echo test' }, {}]) {
    assert.equal((await post(url, `/v1/tasks/${task.id}/start`, input)).status, 400);
  }
  assert.equal((await post(url, `/v1/tasks/${task.id}/start`, { projectId: 'missing' })).status, 404);
  const accepted = await post(url, `/v1/tasks/${task.id}/start`, { projectId: 'sample' });
  assert.equal(accepted.status, 202);
  await accepted.arrayBuffer();
  // No live HTTP request or stream keeps execution alive.
  let completed: Task | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    completed = await (await get(`/v1/tasks/${task.id}`)).json() as Task;
    if (completed.status === 'succeeded' || completed.status === 'failed') break;
    await delay(20);
  }
  assert.equal(completed?.status, 'succeeded');
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'Original project\n');
  await app!.close();
  app = undefined;
  url = await start();
  assert.equal((await (await get(`/v1/tasks/${task.id}`)).json()).status, 'succeeded');
  const events = await (await get(`/v1/tasks/${task.id}/events`)).json();
  assert.ok(events.items.some((event: { type: string }) => event.type === 'task.output'));
  assert.match(JSON.stringify(events), /Update README/);
  const diff = await (await get(`/v1/tasks/${task.id}/diff`)).json();
  assert.match(diff.patch, /Updated by server agent/);
  assert.equal(diff.truncated, false);
  const cancelDraft = await post(url, '/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'Wait until cancelled' }] });
  const cancelTask = (await cancelDraft.json()).task as Task;
  assert.equal((await post(url, `/v1/tasks/${cancelTask.id}/start`, { projectId: 'sample' })).status, 202);
  const cancelDeadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < cancelDeadline) {
    const progress = await (await get(`/v1/tasks/${cancelTask.id}/events`)).json();
    if (JSON.stringify(progress).includes('waiting-for-cancel')) { ready = true; break; }
    await delay(20);
  }
  assert.equal(ready, true, 'External process must be running before cancellation');
  const cancelled = await fetch(`${url}/v1/tasks/${cancelTask.id}/cancel`, { method: 'POST', headers: { authorization } });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  await delay(50);
  assert.equal((await (await get(`/v1/tasks/${cancelTask.id}`)).json()).status, 'cancelled');
});
