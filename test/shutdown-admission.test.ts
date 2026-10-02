import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { ExecutionService } from '../src/application/execution-service.js';
import type { ExecutionRequest, ExecutionResult } from '../src/domain/execution.js';
import { FileInstructionWorkspace } from '../src/infrastructure/files/instruction-workspace.js';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

type Services = Awaited<ReturnType<typeof openRunnerServices>>;
type Held = { request: ExecutionRequest; fail: (error: Error) => void; release: () => void };
const exec = promisify(execFile);
const authorization = 'Bearer shutdown-admission-token';
const message = (text: string) => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text }] });

async function until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  }
  throw new Error('Shutdown admission condition timed out');
}

async function repositoryFixture(root: string) {
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'README.md'), 'Shutdown fixture\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
  return source;
}

async function fixture(t: TestContext, concurrency = 2, holdAbort = false) {
  const root = await mkdtemp(join(tmpdir(), 'runner-shutdown-admission-'));
  const source = await repositoryFixture(root);
  const dataDir = join(root, 'data');
  const runnerId = randomUUID();
  const held = new Map<string, Held>();
  const calls: ExecutionRequest[] = [];
  let services: Services | undefined;
  let app: INestApplication | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      try { await services?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  const options = { executionConcurrency: concurrency, projects: [{ id: 'sample', name: 'Sample', path: source }],
    providers: [{ provider: 'claude' as const, supportsAttachments: false, execute: async (request: ExecutionRequest) => {
      calls.push(request);
      const sessionId = request.resumeSessionId ?? randomUUID();
      await request.onSession?.(sessionId);
      const text = request.task.parts.find(part => part.type === 'text');
      if (!text || text.type !== 'text' || text.text !== 'hold') return { exitCode: 0, sessionId };
      return new Promise<ExecutionResult>((resolve, reject) => {
        let released = !holdAbort;
        const cancel = () => { if (released) resolve({ exitCode: null, error: 'cancelled' }); };
        held.set(request.task.id, { request, fail: reject, release: () => { released = true; if (request.signal.aborted) cancel(); } });
        request.signal.addEventListener('abort', cancel, { once: true });
        if (request.signal.aborted) cancel();
      });
    } }] };
  async function open(execution = true) {
    await app?.close();
    app = undefined;
    await services?.close();
    services = await openRunnerServices(dataDir, runnerId, execution ? options : undefined);
    return services;
  }
  async function serve() {
    app = await createRunnerApplication({ runnerId, name: 'Shutdown test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services!);
    await app.listen(0, '127.0.0.1');
    return { app, url: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` };
  }
  function closeApp() {
    const closing = app!.close();
    app = undefined;
    return closing;
  }
  async function finished(id: string) {
    return until(() => services!.tasks.get(id), task => !['queued', 'running'].includes(task.status));
  }
  async function completedTurn() {
    const task = (await services!.tasks.create({ ...message('complete'), provider: 'claude', isolation: 'in-place' })).task;
    await services!.execution!.start(task.id, { projectId: 'sample' });
    assert.equal((await finished(task.id)).status, 'succeeded');
    return task;
  }
  async function heldContinuation(parentId: string) {
    const { task } = await services!.execution!.continue(parentId, message('hold'));
    return { task, held: await until(() => held.get(task.id), entry => Boolean(entry)) as Held };
  }
  return { open, serve, closeApp, finished, completedTurn, heldContinuation, calls, current: () => services! };
}

async function lifecycleEvents(services: Services, taskId: string) {
  return (await services.tasks.events(taskId, 0)).items.map(event => event.type)
    .filter(type => ['task.failed', 'task.succeeded', 'task.interrupted', 'task.cancelled'].includes(type));
}

test('shutdown settles a running in-place continuation as interrupted before terminals close', { timeout: 20_000 }, async t => {
  const state = await fixture(t);
  let services = await state.open();
  const parent = await state.completedTurn();
  const { task, held } = await state.heldContinuation(parent.id);
  assert.equal(task.parentTaskId, parent.id);
  assert.ok(held.request.resumeSessionId);
  const terminals = services.terminals!;
  const closeTerminals = terminals.close.bind(terminals);
  let abortedBeforeTerminalsClose = false;
  terminals.close = async () => { abortedBeforeTerminalsClose = held.request.signal.aborted; held.fail(new Error('Git operation failed (null)')); await delay(20); return closeTerminals(); };
  await services.close();
  assert.equal(abortedBeforeTerminalsClose, true);
  assert.equal(held.request.signal.aborted, true);

  services = await state.open(false);
  assert.equal((await services.tasks.get(task.id)).status, 'interrupted');
  assert.deepEqual(await lifecycleEvents(services, task.id), ['task.interrupted']);
  assert.equal((await services.tasks.get(parent.id)).status, 'succeeded');
});

test('queued continuation left at shutdown stays queued and runs once in the next runner process', { timeout: 20_000 }, async t => {
  const state = await fixture(t, 1);
  let services = await state.open();
  const parked = await state.completedTurn();
  const parent = await state.completedTurn();
  const active = await state.heldContinuation(parked.id);
  const { task: queued } = await services.execution!.continue(parent.id, message('complete'));
  await delay(50);
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');
  await services.close();

  services = await state.open(false);
  assert.equal((await services.tasks.get(active.task.id)).status, 'interrupted');
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');
  assert.ok(!state.calls.some(request => request.task.id === queued.id));

  services = await state.open();
  assert.equal((await state.finished(queued.id)).status, 'succeeded');
  const runs = state.calls.filter(request => request.task.id === queued.id);
  assert.equal(runs.length, 1);
  assert.ok(runs[0]!.resumeSessionId);
  assert.equal((await services.tasks.events(queued.id, 0)).items.filter(event => event.type === 'task.running').length, 1);
  assert.equal((await services.tasks.get(active.task.id)).status, 'interrupted');
});

test('service close fences execution admission first and is idempotent', { timeout: 20_000 }, async t => {
  const state = await fixture(t);
  const services = await state.open();
  const parent = await state.completedTurn();
  const active = await state.heldContinuation(parent.id);
  const other = await state.completedTurn();
  const first = services.close();
  await assert.rejects(services.execution!.pending(other.id), { code: 'busy' });
  await assert.rejects(services.execution!.continue(other.id, message('complete')), { code: 'busy' });
  await assert.rejects(services.execution!.start(other.id, { projectId: 'sample' }), { code: 'busy' });
  assert.equal(services.close(), first);
  await Promise.all([first, services.close()]);
  assert.equal(active.held.request.signal.aborted, true);

  const reopened = await state.open(false);
  assert.equal((await reopened.tasks.get(active.task.id)).status, 'interrupted');
  assert.deepEqual(await lifecycleEvents(reopened, other.id), ['task.succeeded']);
  assert.equal((await reopened.tasks.list(0)).items.filter(task => task.parentTaskId === other.id).length, 0);
});

test('HTTP shutdown rejects admission as busy while the listener still serves and before tasks settle', { timeout: 20_000 }, async t => {
  const state = await fixture(t, 2, true);
  await state.open();
  const parent = await state.completedTurn();
  const active = await state.heldContinuation(parent.id);
  const other = await state.completedTurn();
  const { app, url } = await state.serve();
  const server = app.getHttpServer();
  const closing = state.closeApp();
  try {
    await until(() => active.held.request.signal.aborted, aborted => aborted);
    assert.equal(server.listening, true);
    const response = await fetch(`${url}/v1/tasks/${other.id}/continue`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(message('complete')) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'busy' });
  } finally {
    active.held.release();
    await closing;
  }
  assert.equal(server.listening, false);

  const reopened = await state.open(false);
  assert.equal((await reopened.tasks.get(active.task.id)).status, 'interrupted');
  assert.deepEqual(await lifecycleEvents(reopened, active.task.id), ['task.interrupted']);
  assert.equal((await reopened.tasks.list(0)).items.filter(task => task.parentTaskId === other.id).length, 0);
});

test('close during an in-flight durable claim interrupts the claimed task without starting its provider', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-claim-close-'));
  const source = await repositoryFixture(root);
  const data = join(root, 'data');
  const repository = await openSqliteRepository(data, randomUUID());
  let entered!: () => void;
  let resume!: () => void;
  const claimed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const executions = new Proxy(repository, { get(target, key) {
    if (key === 'claimNextTask') return async () => { const task = await target.claimNextTask(); if (task) { entered(); await gate; } return task; };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let started = 0;
  const service = new ExecutionService(repository, executions, new ConfiguredProjectRegistry([{ id: 'sample', name: 'Sample', path: source }]),
    new GitProjectWorkspace(data), [{ provider: 'codex', supportsAttachments: false, execute: async () => { started++; return { exitCode: 0 }; } }],
    undefined, undefined, new FileInstructionWorkspace(data));
  t.after(async () => { resume(); await service.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  await service.initialize();
  const task = (await repository.createTask({ ...message('Work'), provider: 'codex', isolation: 'in-place' })).task;
  await service.start(task.id, { projectId: 'sample' });
  await claimed;
  assert.equal((await repository.getTask(task.id)).status, 'running');
  let settled = false;
  const first = service.close().then(() => { settled = true; });
  const second = service.close();
  await delay(50);
  assert.equal(settled, false);
  resume();
  await Promise.all([first, second]);
  assert.equal(started, 0);
  assert.equal((await repository.getTask(task.id)).status, 'interrupted');
  const events = (await repository.listEvents(task.id, 0)).items.map(event => event.type);
  assert.ok(!events.includes('task.failed'));
  assert.equal(events.filter(type => type === 'task.interrupted').length, 1);
});
