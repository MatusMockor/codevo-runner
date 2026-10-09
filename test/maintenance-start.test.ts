import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAINTENANCE_LEASE_MS } from '../src/application/maintenance-lease.js';
import { MAINTENANCE_UPDATE_PROTOCOL_VERSION } from '../src/application/maintenance-service.js';
import { readConfig } from '../src/config.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices, type RunnerExecutionOptions, type RunnerMaintenanceOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { assertUpdaterLease, eventually, ManualClock, schemaShape, updaterIdle, updaterSnapshot, usageProbeStub } from './maintenance-fixture.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const token = 'maintenance-start-token-0123456789abcdef';
const authorization = `Bearer ${token}`;
const staticLease = '00000000-0000-4000-8000-000000000001';
const marker = 'dist/src/application/maintenance-service.js';
const draft = (text: string) => ({ idempotencyKey: randomUUID(), provider: 'claude' as const, parts: [{ type: 'text' as const, text }] });

async function request(url: string, method: string, path: string, headers: Record<string, string>, value?: unknown) {
  const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { status: response.status, body: await response.text() };
}

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-maintenance-start-'));
  const source = join(directory, 'source');
  const dataDir = join(directory, 'data');
  const runnerId = randomUUID();
  const calls: string[] = [];
  let closeCurrent: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await closeCurrent?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'README.md'), 'Start fixture\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
  const usage = await usageProbeStub(directory, false);
  const execution: RunnerExecutionOptions = { accountUsageCli: { claudeExecutable: usage.executable }, projectsRoot: join(directory, 'projects'), projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [{ provider: 'claude', supportsAttachments: false, execute: async (input: ExecutionRequest) => {
      calls.push(input.task.id);
      const sessionId = input.resumeSessionId ?? randomUUID();
      await input.onSession?.(sessionId);
      return { exitCode: 0, sessionId };
    } }] };
  async function start(maintenance?: RunnerMaintenanceOptions) {
    await closeCurrent?.();
    const services = await openRunnerServices(dataDir, runnerId, execution, undefined, maintenance);
    const app = await createRunnerApplication({ runnerId, name: 'Runner under test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    closeCurrent = async () => { closeCurrent = undefined; await app.close(); };
    await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const owner = { authorization, 'x-codevo-runner-id': runnerId };
    const call = (method: string, path: string, value?: unknown, headers: Record<string, string> = owner) => request(url, method, path, headers, value);
    return { services, call, stop: () => closeCurrent?.() };
  }
  return { directory, source, dataDir, runnerId, calls, usage, start };
}

test('the built candidate satisfies the static checks the updater runs while staging', { timeout: 30_000 }, async () => {
  assert.equal(MAINTENANCE_UPDATE_PROTOCOL_VERSION, 1);
  assert.equal(existsSync(join(root, marker)), true);
  assert.equal(existsSync(join(root, 'src/application/maintenance-service.ts')), true);
  const gate = new URL('../src/application/maintenance-service.js', import.meta.url).href;
  const config = new URL('../src/config.js', import.meta.url).href;
  const check = `import {MAINTENANCE_UPDATE_PROTOCOL_VERSION as version} from ${JSON.stringify(gate)}; import {readConfig} from ${JSON.stringify(config)}; const id='${staticLease}'; if(version !== 1 || readConfig({CODEVO_TOKEN_FILE:'/unused',CODEVO_START_MAINTENANCE_LEASE:id}).startMaintenanceLease !== id) throw new Error('Unsupported maintenance protocol');`;
  await exec(process.execPath, ['--input-type=module', '-e', check], { cwd: root, timeout: 15_000 });
  assert.equal(readConfig({ CODEVO_TOKEN_FILE: '/unused', CODEVO_START_MAINTENANCE_LEASE: staticLease }).startMaintenanceLease, staticLease);
  assert.equal(readConfig({ CODEVO_TOKEN_FILE: '/unused' }).startMaintenanceLease, undefined);
  for (const invalid of ['', ' ', 'lease', staticLease.toUpperCase().replace('0', 'A'), ` ${staticLease}`, `${staticLease}\n`, '00000000-0000-1000-8000-000000000001', '00000000-0000-4000-7000-000000000001'])
    assert.throws(() => readConfig({ CODEVO_TOKEN_FILE: '/unused', CODEVO_START_MAINTENANCE_LEASE: invalid }), /CODEVO_START_MAINTENANCE_LEASE/, JSON.stringify(invalid));
});

test('a fresh database has the pinned schema: the updater refuses any candidate that changes it', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-maintenance-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const isolated = join(directory, 'schema-check');
  const module = new URL('../src/infrastructure/sqlite/database.js', import.meta.url).href;
  const code = `import {RepositoryDatabase} from ${JSON.stringify(module)}; const db = new RepositoryDatabase(${JSON.stringify(isolated)}, '${staticLease}'); await db.close();`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { cwd: root, timeout: 15_000 });
  const pinned = JSON.parse(readFileSync(new URL('../../test/fixtures/sqlite-schema-shape.json', import.meta.url), 'utf8')) as ReturnType<typeof schemaShape>;
  assert.deepEqual(schemaShape(join(isolated, 'runner.sqlite')), pinned);
});

test('a runner started with a lease is fenced from its first request and leaves an idle database untouched', { timeout: 30_000 }, async t => {
  const state = await workspace(t);
  const seeded = await openSqliteRepository(state.dataDir, state.runnerId);
  try {
    const project = { id: 'managed', name: 'managed', path: state.source };
    const succeeded = await seeded.createClone({ idempotencyKey: randomUUID(), url: 'https://example.com/team/managed.git', name: 'managed' });
    await seeded.claimClone();
    await seeded.finishClone(succeeded.id, 'succeeded', project, null);
    const failed = await seeded.createClone({ idempotencyKey: randomUUID(), url: 'https://example.com/team/failed.git', name: 'failed' });
    await seeded.claimClone();
    await seeded.finishClone(failed.id, 'failed', null, 'failed');
  } finally { await seeded.close(); }
  const first = await state.start();
  const finished = JSON.parse((await first.call('POST', '/v1/tasks', draft('complete'))).body).task.id as string;
  assert.equal((await first.call('POST', `/v1/tasks/${finished}/start`, { projectId: 'sample' })).status, 202);
  await eventually(async () => JSON.parse((await first.call('GET', `/v1/tasks/${finished}`)).body).status, status => status === 'succeeded', 'seed turn');
  const pending = await first.call('POST', `/v1/tasks/${finished}/pending`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'follow up' }] });
  assert.equal(pending.status, 202, pending.body);
  await eventually(async () => JSON.parse((await first.call('GET', '/v1/tasks')).body).items.length, count => count === 2, 'pending dispatch');
  const cancelled = JSON.parse((await first.call('POST', '/v1/tasks', draft('cancel me'))).body).task.id as string;
  assert.equal((await first.call('POST', `/v1/tasks/${cancelled}/cancel`)).status, 200);
  assert.equal((await first.call('POST', '/v1/tasks', draft('draft'))).status, 201);
  await first.services.attachments.upload(randomUUID(), 'note.txt', 'text/plain', (async function* () { yield Buffer.from('note\n'); })(), new AbortController().signal);
  await eventually(() => first.services.execution!.working, working => !working, 'seed settlement');
  await first.stop();
  const before = updaterSnapshot(state.dataDir);
  assert.equal(updaterIdle(before), true);
  assert.deepEqual(before.tasks, { cancelled: 1, draft: 1, succeeded: 2 });
  assert.deepEqual(before.clones, { failed: 1, succeeded: 1 });
  assert.deepEqual([before.pending, before.attachments, before.managedProjects, before.identity], [0, 1, 1, state.runnerId]);
  const calls = state.calls.length;
  const leaseId = randomUUID();
  const held = await state.start({ startLease: leaseId });
  const refused = await held.call('POST', '/v1/tasks', draft('fenced from the first request'));
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.body), { error: 'busy' });
  assert.deepEqual(JSON.parse((await held.call('GET', '/healthz', undefined, { authorization })).body), { status: 'ok' });
  assert.equal(JSON.parse((await held.call('GET', '/v1/runner', undefined, { authorization })).body).runnerId, before.identity);
  assert.deepEqual(updaterSnapshot(state.dataDir), before);
  assert.equal((await held.call('POST', `/v1/tasks/${finished}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'again' }] })).status, 503);
  for (const path of ['/v1/account-usage/claude', `/v1/tasks/${finished}/resume`, `/v1/tasks/${finished}/diff`, '/v1/projects/sample/git/status']) {
    const spawning = await held.call('GET', path);
    assert.equal(spawning.status, 503, path);
    assert.deepEqual(JSON.parse(spawning.body), { error: 'busy' });
  }
  assert.equal(await state.usage.launched(), 0);
  for (const path of ['/v1/tasks', `/v1/tasks/${finished}`, `/v1/tasks/${finished}/events?after=0`, `/v1/tasks/${finished}/events?before=1000000`, `/v1/tasks/${finished}/pending`, '/v1/thread-metadata', `/v1/tasks/${finished}/thread-metadata`])
    assert.equal((await held.call('GET', path)).status, 200, path);
  assert.equal((await held.call('POST', '/v1/maintenance/prepare', { leaseId: randomUUID() })).status, 409);
  await delay(700);
  assert.deepEqual(updaterSnapshot(state.dataDir), before);
  const lease = await held.call('POST', '/v1/maintenance/prepare', { leaseId });
  assert.equal(lease.status, 200, lease.body);
  assert.equal(assertUpdaterLease(lease.body, leaseId, state.runnerId), MAINTENANCE_LEASE_MS);
  assert.deepEqual(updaterSnapshot(state.dataDir), before);
  assert.equal(state.calls.length, calls);
  const released = await held.call('DELETE', `/v1/maintenance/${leaseId}`);
  assert.equal(released.status, 200);
  assert.deepEqual(JSON.parse(released.body), { leaseId, released: true });
  assert.equal((await held.call('POST', '/v1/tasks', draft('admitted after release'))).status, 201);
  assert.equal((await held.call('GET', '/v1/account-usage/claude')).status, 200);
  assert.equal(await state.usage.launched(), 3);
  const followUp = await held.call('POST', `/v1/tasks/${finished}/pending`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'after the restart' }] });
  assert.equal(followUp.status, 202, followUp.body);
  assert.equal(JSON.parse(followUp.body).pending.status, 'queued');
  await eventually(() => state.calls.length, count => count === calls + 1, 'promotion after the restart');
  await eventually(async () => JSON.parse((await held.call('GET', `/v1/tasks/${finished}/pending`)).body).items.length, count => count === 0, 'drained queue');
});

for (const ending of ['release', 'expiry'] as const) {
  test(`work queued in storage is not started under a start lease and resumes after ${ending}`, { timeout: 30_000 }, async t => {
    const state = await workspace(t);
    const seeded = await openSqliteRepository(state.dataDir, state.runnerId);
    let queued = '';
    try {
      const { task } = await seeded.createTask(draft('queued before the restart'));
      queued = (await seeded.queueTask(task.id, 'sample')).id;
    } finally { await seeded.close(); }
    const before = updaterSnapshot(state.dataDir);
    assert.deepEqual(before.tasks, { queued: 1 });
    const clock = new ManualClock();
    const leaseId = randomUUID();
    const held = await state.start({ startLease: leaseId, clock });
    await delay(700);
    assert.equal(JSON.parse((await held.call('GET', `/v1/tasks/${queued}`)).body).status, 'queued');
    assert.deepEqual(updaterSnapshot(state.dataDir), before);
    assert.deepEqual(state.calls, []);
    assert.equal(held.services.execution!.working, false);
    if (ending === 'release') assert.equal((await held.call('DELETE', `/v1/maintenance/${leaseId}`)).status, 200);
    if (ending === 'expiry') clock.advance(MAINTENANCE_LEASE_MS);
    await eventually(async () => JSON.parse((await held.call('GET', `/v1/tasks/${queued}`)).body).status, status => status === 'succeeded', 'queued turn');
    assert.deepEqual(state.calls, [queued]);
    assert.equal((await held.call('POST', '/v1/tasks', draft('admitted'))).status, 201);
  });
}

test('the production entry point starts fenced from CODEVO_START_MAINTENANCE_LEASE and rejects an invalid value', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-maintenance-main-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  const leaseId = randomUUID();
  const environment = (lease: string) => ({ PATH: process.env.PATH ?? '', HOME: directory, CODEVO_HOST: '127.0.0.1', CODEVO_PORT: String(port),
    CODEVO_TOKEN_FILE: tokenFile, CODEVO_DATA_DIR: join(directory, 'data'), CODEVO_START_MAINTENANCE_LEASE: lease });
  const main = join(root, 'dist/src/main.js');
  const invalid = spawn(process.execPath, [main], { env: environment('not-a-lease'), stdio: ['ignore', 'ignore', 'pipe'] });
  const [invalidCode] = await once(invalid, 'exit');
  assert.equal(invalidCode, 1);
  assert.equal(existsSync(join(directory, 'data')), false);
  const runner = spawn(process.execPath, [main], { env: environment(leaseId), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (runner.exitCode === null && runner.signalCode === null) { runner.kill('SIGKILL'); await once(runner, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  runner.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  await eventually(() => output, text => text.includes('listening') || runner.exitCode !== null, 'runner start');
  assert.equal(runner.exitCode, null, output);
  const url = `http://127.0.0.1:${port}`;
  const discovery = JSON.parse((await request(url, 'GET', '/v1/runner', { authorization })).body) as { runnerId: string };
  const owner = { authorization, 'x-codevo-runner-id': discovery.runnerId };
  assert.deepEqual(JSON.parse((await request(url, 'GET', '/healthz', { authorization })).body), { status: 'ok' });
  const fenced = await request(url, 'POST', '/v1/tasks', owner, draft('fenced'));
  assert.equal(fenced.status, 503);
  assert.deepEqual(JSON.parse(fenced.body), { error: 'busy' });
  assert.equal((await request(url, 'GET', '/v1/tasks', owner)).status, 200);
  const snapshot = updaterSnapshot(join(directory, 'data'));
  assert.deepEqual([snapshot.identity, snapshot.tasks, snapshot.clones, snapshot.pending], [discovery.runnerId, {}, {}, 0]);
  const lease = await request(url, 'POST', '/v1/maintenance/prepare', owner, { leaseId });
  assert.equal(lease.status, 200, lease.body);
  assertUpdaterLease(lease.body, leaseId, discovery.runnerId);
  assert.deepEqual(JSON.parse((await request(url, 'DELETE', `/v1/maintenance/${leaseId}`, owner)).body), { leaseId, released: true });
  assert.equal((await request(url, 'POST', '/v1/tasks', owner, draft('admitted'))).status, 201);
  runner.kill('SIGTERM');
  const [code] = await once(runner, 'exit');
  assert.equal(code, 0);
});
