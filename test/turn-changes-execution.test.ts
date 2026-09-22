import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { openRunnerServices } from '../src/runtime.js';
import type { ProviderExecutor } from '../src/application/execution-ports.js';
import { FileTurnChangesStore } from '../src/infrastructure/projects/turn-changes.js';

const exec = promisify(execFile);
const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const, isolation: 'in-place' as const, parts: [{ type: 'text' as const, text: 'Make this turn edit' }] });
async function until(read: () => Promise<boolean>, explanation: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await read()) return; await delay(10); }
  throw new Error(`Timed out: ${explanation}`);
}
async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'turn-changes-execution-'));
  let close = async () => {};
  t.after(async () => { try { await close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const source = join(root, 'source'); const dataDir = join(root, 'data');
  await mkdir(source);
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: source });
  await git('init');
  await writeFile(join(source, 'a.txt'), 'committed A\n');
  await writeFile(join(source, 'b.txt'), 'committed B\n');
  await writeFile(join(source, 'untouched.txt'), 'committed untouched\n');
  await git('add', '.'); await git('commit', '-m', 'initial');
  return { cleanupWith(action: () => Promise<void>) { close = action; }, source, dataDir, git, runnerId: randomUUID(), project: { id: 'project', name: 'Project', path: source } };
}

test('production execution captures each continuation against its own dirty baseline and preserves historical diffs across restart', async t => {
  const { source, dataDir, git, runnerId, project, cleanupWith } = await workspace(t);
  await writeFile(join(source, 'a.txt'), 'user A before turn\n');
  await writeFile(join(source, 'untouched.txt'), 'user untouched dirty\n');
  const sessionId = randomUUID(); let turn = 0;
  const provider: ProviderExecutor = { provider: 'codex', supportsAttachments: false, execute: async request => {
    await request.onSession?.(sessionId);
    if (turn++ === 0) {
      assert.equal(await readFile(join(request.cwd, 'a.txt'), 'utf8'), 'user A before turn\n');
      await writeFile(join(request.cwd, 'a.txt'), 'agent A first turn\n');
    } else {
      await writeFile(join(request.cwd, 'b.txt'), 'agent B second turn\n');
      await git('add', 'b.txt'); await git('commit', '-m', 'second turn committed change');
    }
    return { exitCode: 0, sessionId };
  } };
  let services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  cleanupWith(() => services.close());
  const first = (await services.tasks.create(input())).task;
  await services.execution!.start(first.id, { projectId: project.id });
  const store = new FileTurnChangesStore(dataDir);
  await until(async () => (await store.summary(first.id)).state === 'ready', 'first turn captured');
  await until(async () => (await services.tasks.get(first.id)).status === 'succeeded', 'first turn finished');
  const firstSummary = await store.summary(first.id);
  assert.deepEqual(firstSummary.files.map(file => file.relativePath), ['a.txt']);
  assert.equal(firstSummary.truncated, false);
  assert.equal(firstSummary.files[0]!.status, 'modified');
  assert.equal(firstSummary.files[0]!.addedLines, 1);
  assert.equal(firstSummary.files[0]!.deletedLines, 1);
  const firstDiff = await store.diff(first.id, 'a.txt');
  assert.equal(firstDiff.original.text, 'user A before turn\n');
  assert.equal(firstDiff.modified.text, 'agent A first turn\n');
  const second = (await services.execution!.continue(first.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Second turn' }] })).task;
  await until(async () => (await store.summary(second.id)).state === 'ready', 'second turn captured');
  assert.deepEqual((await store.summary(second.id)).files.map(file => file.relativePath), ['b.txt']);
  assert.equal((await store.diff(second.id, 'b.txt')).original.text, 'committed B\n');
  assert.equal((await store.diff(second.id, 'b.txt')).modified.text, 'agent B second turn\n');
  await writeFile(join(source, 'a.txt'), 'manual edit after both turns\n');
  await writeFile(join(source, 'b.txt'), 'manual B after both turns\n');
  await services.close();
  services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  const restarted = new FileTurnChangesStore(dataDir);
  assert.deepEqual(await restarted.summary(first.id), firstSummary);
  assert.deepEqual(await restarted.diff(first.id, 'a.txt'), firstDiff);
  assert.equal((await restarted.diff(second.id, 'b.txt')).modified.text, 'agent B second turn\n');
  await assert.rejects(restarted.diff(first.id, 'untouched.txt'), { code: 'not_found' });
});

test('failed provider execution retains its actual file changes without counting unrelated baseline dirt', async t => {
  const { source, dataDir, runnerId, project, cleanupWith } = await workspace(t);
  await writeFile(join(source, 'untouched.txt'), 'user dirt\n');
  const provider: ProviderExecutor = { provider: 'codex', supportsAttachments: false, execute: async request => {
    await writeFile(join(request.cwd, 'a.txt'), 'edit before provider failure\n');
    throw new Error('Provider failed after editing');
  } };
  const services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  cleanupWith(() => services.close());
  const first = (await services.tasks.create(input())).task;
  await services.execution!.start(first.id, { projectId: project.id });
  const store = new FileTurnChangesStore(dataDir);
  await until(async () => (await store.summary(first.id)).state === 'ready', 'failed turn captured');
  await until(async () => (await services.tasks.get(first.id)).status === 'failed', 'provider failure persisted');
  assert.deepEqual((await store.summary(first.id)).files.map(file => file.relativePath), ['a.txt']);
  assert.equal((await store.diff(first.id, 'a.txt')).modified.text, 'edit before provider failure\n');
});

test('turn changes HTTP is authenticated and task scoped with a closed relative-path request', async t => {
  const { dataDir, runnerId, project, cleanupWith } = await workspace(t);
  const provider: ProviderExecutor = { provider: 'codex', supportsAttachments: false, execute: async request => {
    await writeFile(join(request.cwd, 'a.txt'), 'HTTP captured change\n');
    return { exitCode: 0 };
  } };
  const services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  const { createRunnerApplication } = await import('../src/server.js');
  const app = await createRunnerApplication({ runnerId, name: 'turn changes', protocolVersion: 1, capabilities: { taskExecution: true, eventReplay: true } }, header => header === 'Bearer turn-change-test', services);
  cleanupWith(() => app.close());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${address.port}/v1/tasks`;
  const headers = { authorization: 'Bearer turn-change-test', 'x-codevo-runner-id': runnerId, 'content-type': 'application/json' };
  const task = (await services.tasks.create(input())).task;
  await services.execution!.start(task.id, { projectId: project.id });
  const store = new FileTurnChangesStore(dataDir);
  await until(async () => (await store.summary(task.id)).state === 'ready', 'HTTP turn ready');
  const summaryUrl = `${base}/${task.id}/turn-changes`;
  assert.equal((await fetch(summaryUrl)).status, 401);
  assert.equal((await fetch(summaryUrl, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
  const summary = await fetch(summaryUrl, { headers });
  assert.equal(summary.status, 200);
  assert.deepEqual(await summary.json(), await store.summary(task.id));
  assert.equal((await fetch(`${base}/${randomUUID()}/turn-changes`, { headers })).status, 404);
  const diff = (body: unknown) => fetch(`${base}/${task.id}/turn-file-diff`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await diff({ relativePath: 'a.txt', extra: true })).status, 400);
  assert.equal((await diff({ relativePath: '../a.txt' })).status, 400);
  assert.equal((await diff({ relativePath: 'untouched.txt' })).status, 404);
  const capturedDiff = await diff({ relativePath: 'a.txt' });
  assert.equal(capturedDiff.status, 200);
  assert.deepEqual(await capturedDiff.json(), await store.diff(task.id, 'a.txt'));
});

test('cancelling a provider cannot publish an unfinished capture as a completed historical diff', async t => {
  const { dataDir, runnerId, project, cleanupWith } = await workspace(t);
  let wrote = false; let executions = 0;
  const provider: ProviderExecutor = { provider: 'codex', supportsAttachments: false, execute: async request => {
    if (executions++ > 0) return { exitCode: 0 };
    await writeFile(join(request.cwd, 'a.txt'), 'edit before cancellation\n');
    wrote = true;
    return new Promise(resolve => {
      request.signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
      if (request.signal.aborted) resolve({ exitCode: null });
    });
  } };
  const services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  cleanupWith(() => services.close());
  const task = (await services.tasks.create(input())).task;
  await services.execution!.start(task.id, { projectId: project.id });
  await until(async () => wrote, 'provider edited its workspace');
  await services.execution!.cancel(task.id);
  const next = (await services.tasks.create(input())).task;
  await services.execution!.start(next.id, { projectId: project.id });
  await until(async () => (await services.tasks.get(next.id)).status === 'succeeded', 'worker progressed past cancelled capture without shutdown');
  const summary = await new FileTurnChangesStore(dataDir).summary(task.id);
  assert.equal(summary.state, 'unavailable');
  assert.notEqual(summary.reason, null);
  assert.deepEqual(summary.files, []);
});

test('an over-budget baseline remains unavailable while the authorized provider still runs successfully', async t => {
  const { source, dataDir, runnerId, project, cleanupWith } = await workspace(t);
  await writeFile(join(source, 'too-large.txt'), Buffer.alloc(9 * 1024 * 1024, 65));
  let executed = false;
  const provider: ProviderExecutor = { provider: 'codex', supportsAttachments: false, execute: async request => {
    executed = true;
    await writeFile(join(request.cwd, 'a.txt'), 'agent still ran\n');
    return { exitCode: 0 };
  } };
  const services = await openRunnerServices(dataDir, runnerId, { projects: [project], providers: [provider] });
  cleanupWith(() => services.close());
  const task = (await services.tasks.create(input())).task;
  await services.execution!.start(task.id, { projectId: project.id });
  await until(async () => (await services.tasks.get(task.id)).status === 'succeeded', 'provider completes despite baseline capture failure');
  assert.equal(executed, true);
  assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), 'agent still ran\n');
  const summary = await new FileTurnChangesStore(dataDir).summary(task.id);
  assert.equal(summary.state, 'unavailable');
  assert.notEqual(summary.reason, null);
  assert.deepEqual(summary.files, []);
});

test('cancellation reaches an awaiting end-capture and the worker proceeds without publishing completion', async t => {
  const { source, dataDir, runnerId, project, cleanupWith } = await workspace(t);
  const { stat } = await import('node:fs/promises');
  const { ExecutionService } = await import('../src/application/execution-service.js');
  const { openSqliteRepository } = await import('../src/infrastructure/sqlite/index.js');
  const repository = await openSqliteRepository(dataDir, runnerId);
  let endSignal: AbortSignal | undefined;
  let captureCalls = 0; let endCancelled = false;
  const service = new ExecutionService(repository, repository, {
    list: async () => [project], get: async () => project,
  }, {
    prepare: async () => source, resume: async () => source,
    identity: async () => { const info = await stat(source); return { dev: info.dev, ino: info.ino }; },
    diff: async () => { throw new Error('Live diff must not be used'); },
    files: async () => { throw new Error('Live files must not be used'); },
    fileDiff: async () => { throw new Error('Live diff must not be used'); },
  }, [{ provider: 'codex', supportsAttachments: false, execute: async () => ({ exitCode: 0 }) }],
  undefined, undefined, { apply: async () => undefined }, undefined, {
    captureStart: async () => undefined,
    captureEnd: async (_id, _cwd, _identity, signal) => {
      if (captureCalls++ > 0) return;
      endSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { endCancelled = true; reject(new Error('End capture aborted')); }, { once: true });
      });
      throw new Error('Cancelled end capture must not reach publication');
    },
    summary: async turnId => ({ turnId, state: 'unavailable', files: [], truncated: false, reason: 'No committed capture' }),
    diff: async () => { throw new Error('No committed capture'); },
  });
  cleanupWith(async () => { await service.close(); await repository.close(); });
  await service.initialize();
  const task = (await repository.createTask(input())).task;
  await service.start(task.id, { projectId: project.id });
  await until(async () => endSignal !== undefined, 'worker enters end capture');
  await service.cancel(task.id);
  const next = (await repository.createTask(input())).task;
  await service.start(next.id, { projectId: project.id });
  await until(async () => (await repository.getTask(next.id)).status === 'succeeded', 'worker resumes after end capture cancellation');
  assert.equal(endSignal!.aborted, true);
  assert.equal(endCancelled, true);
  assert.equal((await repository.getTask(task.id)).status, 'cancelled');
  assert.equal((await service.turnSummary(task.id)).state, 'unavailable');
});
