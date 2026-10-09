import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { MAINTENANCE_LEASE_MS, MaintenanceLease } from '../src/application/maintenance-lease.js';
import { MAINTENANCE_UPDATE_PROTOCOL_VERSION, MaintenanceService, RunnerIdleProbe } from '../src/application/maintenance-service.js';
import { ProjectCloneService } from '../src/application/project-clone-service.js';
import type { WorkSource } from '../src/application/execution-ports.js';
import { TerminalService } from '../src/application/terminal-service.js';
import type { TerminalProcessFactory } from '../src/application/terminal-ports.js';
import { ConfiguredProjectRegistry } from '../src/infrastructure/projects/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { gitSyncFixture } from './git-sync-fixture.js';
import { eventually, ManualClock } from './maintenance-fixture.js';

const exec = promisify(execFile);
const message = (text: string) => ({ idempotencyKey: randomUUID(), provider: 'claude' as const, parts: [{ type: 'text' as const, text }] });
const cloneInput = (name: string) => ({ idempotencyKey: randomUUID(), url: 'https://example.com/team/repo.git', name });

async function fixture(t: TestContext, startLeaseId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'runner-maintenance-service-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(root, runnerId);
  const clock = new ManualClock();
  const lease = new MaintenanceLease(clock, startLeaseId);
  const source = { working: false };
  const sources: readonly WorkSource[] = [source];
  const service = new MaintenanceService(runnerId, lease, new RunnerIdleProbe(repository, sources));
  t.after(async () => {
    lease.close();
    await repository.close();
    await rm(root, { recursive: true, force: true });
  });
  const queueTask = async () => {
    const { task } = await repository.createTask(message('work'));
    return repository.queueTask(task.id, 'sample');
  };
  const mutates = () => {
    const admission = lease.admit();
    if (admission.kind === 'admitted') admission.release();
    return admission.kind;
  };
  return { root, runnerId, repository, clock, lease, service, source, queueTask, mutates };
}

test('the lease duration satisfies the updater bounds and the protocol version is 1', () => {
  assert.equal(MAINTENANCE_UPDATE_PROTOCOL_VERSION, 1);
  assert.ok(Number.isInteger(MAINTENANCE_LEASE_MS));
  assert.ok(5000 < MAINTENANCE_LEASE_MS && MAINTENANCE_LEASE_MS <= 60000);
});

test('an idle runner grants a lease, fences mutations and renews the same lease without probing again', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  assert.equal(state.mutates(), 'admitted');
  assert.deepEqual(await state.service.prepare({ leaseId }), { leaseId, runnerId: state.runnerId, expiresInMs: MAINTENANCE_LEASE_MS });
  assert.equal(state.lease.fenced, true);
  assert.equal(state.mutates(), 'refused');
  state.clock.advance(MAINTENANCE_LEASE_MS - 1);
  assert.equal(state.lease.fenced, true);
  await state.queueTask();
  state.source.working = true;
  assert.deepEqual(await state.service.prepare({ leaseId }), { leaseId, runnerId: state.runnerId, expiresInMs: MAINTENANCE_LEASE_MS });
  state.clock.advance(MAINTENANCE_LEASE_MS - 1);
  assert.equal(state.mutates(), 'refused');
  state.clock.advance(1);
  assert.equal(state.lease.fenced, false);
  assert.equal(state.mutates(), 'admitted');
});

test('a held lease refuses another lease id and keeps its owner', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  await state.service.prepare({ leaseId });
  await assert.rejects(state.service.prepare({ leaseId: randomUUID() }), { code: 'conflict' });
  assert.equal(state.lease.fenced, true);
  assert.equal((await state.service.prepare({ leaseId })).leaseId, leaseId);
});

test('release frees the lease once and an unknown or malformed lease id is deterministic', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID(), unknown = randomUUID();
  await state.service.prepare({ leaseId });
  assert.deepEqual(state.service.release(unknown), { leaseId: unknown, released: false });
  assert.equal(state.lease.fenced, true);
  assert.deepEqual(state.service.release(leaseId), { leaseId, released: true });
  assert.equal(state.lease.fenced, false);
  assert.equal(state.mutates(), 'admitted');
  assert.deepEqual(state.service.release(leaseId), { leaseId, released: false });
  assert.throws(() => state.service.release('not-a-lease'), { code: 'invalid_input' });
  assert.equal((await state.service.prepare({ leaseId: unknown })).leaseId, unknown);
});

test('prepare accepts exactly one UUID leaseId field', async t => {
  const state = await fixture(t);
  for (const input of [undefined, null, [], 'lease', {}, { leaseId: 7 }, { leaseId: 'lease' }, { leaseId: randomUUID().toUpperCase() }, { leaseId: randomUUID(), extra: true }, { lease: randomUUID() }])
    await assert.rejects(state.service.prepare(input), { code: 'invalid_input' });
  assert.equal(state.lease.fenced, false);
});

test('a lease expires by its timer and by its deadline when the timer never fires', async t => {
  const state = await fixture(t);
  let opened = 0;
  state.lease.onOpen(() => { opened++; });
  await state.service.prepare({ leaseId: randomUUID() });
  state.clock.advance(MAINTENANCE_LEASE_MS);
  await delay(0);
  assert.equal(state.lease.fenced, false);
  assert.equal(opened, 1);
  assert.equal(state.clock.scheduled, 0);
  const second = randomUUID();
  await state.service.prepare({ leaseId: second });
  state.clock.skip(MAINTENANCE_LEASE_MS);
  assert.equal(state.mutates(), 'admitted');
  await delay(0);
  assert.equal(opened, 2);
  assert.deepEqual(state.service.release(second), { leaseId: second, released: false });
});

test('a runner started with a lease is fenced from construction and behaves as a normal lease', async t => {
  const leaseId = randomUUID();
  const state = await fixture(t, leaseId);
  assert.equal(state.lease.fenced, true);
  assert.equal(state.mutates(), 'refused');
  await state.queueTask();
  await assert.rejects(state.service.prepare({ leaseId: randomUUID() }), { code: 'conflict' });
  assert.deepEqual(await state.service.prepare({ leaseId }), { leaseId, runnerId: state.runnerId, expiresInMs: MAINTENANCE_LEASE_MS });
  state.clock.advance(MAINTENANCE_LEASE_MS);
  assert.equal(state.lease.fenced, false);
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  assert.equal(state.lease.fenced, false);
});

test('lease timers never accumulate across renew, release, expiry and close', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  assert.equal(state.clock.scheduled, 0);
  for (let renewal = 0; renewal < 50; renewal++) {
    await state.service.prepare({ leaseId });
    assert.equal(state.clock.scheduled, 1);
  }
  state.service.release(leaseId);
  assert.equal(state.clock.scheduled, 0);
  await state.queueTask();
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  assert.equal(state.clock.scheduled, 0);
  const held = new MaintenanceLease(state.clock, leaseId);
  assert.equal(state.clock.scheduled, 1);
  held.close();
  assert.equal(state.clock.scheduled, 0);
  assert.equal(held.fenced, true);
  assert.deepEqual(held.claim(leaseId), { kind: 'refused' });
});

test('the system clock lease timer does not keep a process alive', { timeout: 20_000 }, async () => {
  const module = new URL('../src/application/maintenance-lease.js', import.meta.url).href;
  const script = `import { MaintenanceLease } from ${JSON.stringify(module)}; const lease = new MaintenanceLease(undefined, ${JSON.stringify(randomUUID())}); console.log(lease.fenced);`;
  const started = Date.now();
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
  assert.equal(stdout.trim(), 'true');
  assert.ok(Date.now() - started < 10_000);
});

test('a busy runner is refused and the tentative fence is dropped', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  let opened = 0;
  state.lease.onOpen(() => { opened++; });
  const queued = await state.queueTask();
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  assert.equal(state.lease.fenced, false);
  assert.equal(state.mutates(), 'admitted');
  await delay(0);
  assert.equal(opened, 1);
  assert.equal((await state.repository.claimNextTask())?.id, queued.id);
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  await state.repository.finishTask(queued.id, { exitCode: 0 });
  state.source.working = true;
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  assert.equal(state.lease.fenced, false);
  state.source.working = false;
  assert.equal((await state.service.prepare({ leaseId })).leaseId, leaseId);
});

test('the idle probe mirrors the updater activity definition for tasks, clones and pending messages', async t => {
  const state = await fixture(t);
  const probe = new RunnerIdleProbe(state.repository, []);
  const idle = { activeTasks: 0, activeClones: 0, queuedPendingMessages: 0 };
  assert.deepEqual(await state.repository.runnerActivity(), idle);
  const { task: draft } = await state.repository.createTask(message('draft'));
  assert.equal(await probe.idle(), true);
  await state.repository.queueTask(draft.id, 'sample');
  assert.deepEqual(await state.repository.runnerActivity(), { ...idle, activeTasks: 1 });
  assert.equal(await probe.idle(), false);
  await state.repository.claimNextTask();
  assert.deepEqual(await state.repository.runnerActivity(), { ...idle, activeTasks: 1 });
  assert.equal(await probe.idle(), false);
  await state.repository.finishTask(draft.id, { exitCode: 0 });
  assert.equal(await probe.idle(), true);
  const { pending } = await state.repository.enqueuePending(draft.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'next' }] });
  assert.deepEqual(await state.repository.runnerActivity(), { ...idle, queuedPendingMessages: 1 });
  assert.equal(await probe.idle(), false);
  await state.repository.removePending(draft.id, pending.id);
  assert.equal(await probe.idle(), true);
  const clone = await state.repository.createClone(cloneInput('example'));
  assert.deepEqual(await state.repository.runnerActivity(), { ...idle, activeClones: 1 });
  assert.equal(await probe.idle(), false);
  await state.repository.claimClone();
  assert.deepEqual(await state.repository.runnerActivity(), { ...idle, activeClones: 1 });
  assert.equal(await probe.idle(), false);
  await state.repository.finishClone(clone.id, 'failed', null, 'failed');
  assert.deepEqual(await state.repository.runnerActivity(), idle);
  assert.equal(await probe.idle(), true);
});

test('work that starts while the probe reads storage is still seen', async t => {
  const state = await fixture(t);
  const probing = state.service.prepare({ leaseId: randomUUID() });
  state.source.working = true;
  await assert.rejects(probing, { code: 'conflict' });
  assert.equal(state.lease.fenced, false);
});

test('a mutation in flight blocks the grant until it is released exactly once', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const first = state.lease.admit(), second = state.lease.admit();
  assert.equal(first.kind, 'admitted');
  assert.equal(second.kind, 'admitted');
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  assert.equal(state.lease.fenced, false);
  if (first.kind === 'admitted') { first.release(); first.release(); }
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  if (second.kind === 'admitted') second.release();
  assert.equal((await state.service.prepare({ leaseId })).leaseId, leaseId);
  assert.equal(state.lease.admit().kind, 'refused');
});

test('the fence is taken before the probe and concurrent or superseded grants fail closed', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID(), other = randomUUID();
  const first = state.service.prepare({ leaseId });
  assert.equal(state.lease.fenced, true);
  assert.equal(state.mutates(), 'refused');
  await assert.rejects(state.service.prepare({ leaseId }), { code: 'conflict' });
  await assert.rejects(state.service.prepare({ leaseId: other }), { code: 'conflict' });
  assert.equal((await first).leaseId, leaseId);
  state.service.release(leaseId);
  const stale = state.service.prepare({ leaseId });
  assert.deepEqual(state.service.release(leaseId), { leaseId, released: true });
  assert.equal(state.mutates(), 'admitted');
  const fresh = state.service.prepare({ leaseId });
  await assert.rejects(stale, { code: 'conflict' });
  assert.equal((await fresh).leaseId, leaseId);
  assert.equal(state.lease.fenced, true);
});

test('a storage failure during the probe is reported and never leaves the fence up', async t => {
  const state = await fixture(t);
  await state.repository.close();
  await assert.rejects(state.service.prepare({ leaseId: randomUUID() }), { code: 'storage_unavailable' });
  assert.equal(state.lease.fenced, false);
  assert.equal(state.clock.scheduled, 0);
});

test('the clone worker claims nothing while fenced and resumes after the lease ends', { timeout: 20_000 }, async t => {
  const leaseId = randomUUID();
  const state = await fixture(t, leaseId);
  const cloned: string[] = [];
  const clones = new ProjectCloneService(state.repository, { clone: async (input, jobId) => {
    cloned.push(jobId);
    return { project: { id: input.name, name: input.name, path: join(state.root, input.name) }, rollback: async () => undefined };
  } }, new ConfiguredProjectRegistry([]), state.lease);
  try {
    await clones.initialize();
    const job = await state.repository.createClone(cloneInput('gated'));
    await delay(1_200);
    assert.equal((await clones.get(job.id)).status, 'queued');
    assert.deepEqual(cloned, []);
    assert.equal(clones.working, false);
    assert.deepEqual(state.service.release(leaseId), { leaseId, released: true });
    const finished = await eventually(() => clones.get(job.id), value => value.status === 'succeeded', 'gated clone');
    assert.deepEqual(finished.project, { id: 'gated', name: 'gated' });
    assert.deepEqual(cloned, [job.id]);
  } finally { await clones.close(); }
});

test('an open terminal counts as work until its process exits or the session is closed', async () => {
  let exit = (_code: number | null) => {};
  const resolver = { async resolve() { return { cwd: '/tmp', identity: { dev: 1, ino: 1 }, async revalidate() {} }; } };
  const factory: TerminalProcessFactory = { async open(_workspace, _size, _onData, onExit) {
    exit = onExit;
    return { write() {}, resize() {}, close() {}, ownedProcesses() { return []; } };
  } };
  const terminals = new TerminalService(resolver, factory);
  try {
    assert.equal(terminals.working, false);
    const opening = terminals.open('sample', { cols: 80, rows: 24 });
    assert.equal(terminals.working, true);
    await opening;
    assert.equal(terminals.working, true);
    exit(0);
    assert.equal(terminals.working, false);
    const session = await terminals.open('sample', { cols: 80, rows: 24 });
    assert.equal(terminals.working, true);
    terminals.closeSession('sample', session.id);
    assert.equal(terminals.working, false);
  } finally { await terminals.close(); }
});

test('a Git operation running after its request returned blocks the grant until it settles', { timeout: 30_000 }, async t => {
  const state = await gitSyncFixture(t);
  const maintenance = state.services.maintenance;
  const leaseId = randomUUID();
  await state.mode('block');
  const operation = await state.sync.fetch('project', { idempotencyKey: randomUUID() });
  assert.equal(operation.status, 'running');
  assert.equal(state.sync.working, true);
  await assert.rejects(maintenance.prepare({ leaseId }), { code: 'conflict' });
  const admission = maintenance.admit();
  assert.equal(admission.kind, 'admitted');
  if (admission.kind === 'admitted') admission.release();
  await writeFile(join(state.ssh, 'release'), '');
  assert.equal((await state.operation(operation.id)).status, 'succeeded');
  await eventually(() => state.sync.working, working => !working, 'Git operation settlement');
  assert.equal((await maintenance.prepare({ leaseId })).leaseId, leaseId);
  assert.equal(maintenance.admit().kind, 'refused');
});
