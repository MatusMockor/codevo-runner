import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openRunnerServices } from '../src/runtime.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-lifecycle-'));
  const project = join(directory, 'project');
  const dataDir = join(directory, 'data');
  const executable = join(directory, 'fixture-codex');
  let services: Awaited<ReturnType<typeof openRunnerServices>> | undefined;
  t.after(async () => { await services?.close(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(project);
  const git = promisify(execFile);
  await git('git', ['init', project]);
  await writeFile(join(project, 'README.md'), 'Lifecycle fixture\n');
  await git('git', ['-C', project, 'add', 'README.md']);
  await git('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
  // Only the external provider is substituted; process ownership, Git workspaces,
  // service scheduling and durable SQLite state use the production implementation.
  await writeFile(executable, `#!${process.execPath}
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '${randomUUID()}' }));
  if (prompt === 'hold') {
    console.log(JSON.stringify({ type: 'item.completed', text: 'started:' + process.pid }));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.startsWith('check-stopped:')) {
    const pid = Number(prompt.slice('check-stopped:'.length));
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    console.log(JSON.stringify({ type: 'item.completed', text: 'prior-alive:' + alive }));
    console.log(JSON.stringify({ type: alive ? 'turn.failed' : 'turn.completed' }));
    process.exitCode = alive ? 2 : 0;
    return;
  }
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`, { mode: 0o700 });
  const runnerId = randomUUID();
  const options = { projects: [{ id: 'sample', name: 'Sample', path: project }],
    providers: [new CliProviderExecutor('codex', { executable, timeoutMs: 10_000 })] };
  async function reopen(execution = true) {
    await services?.close();
    services = await openRunnerServices(dataDir, runnerId, execution ? options : undefined);
    return services;
  }
  return { services: await reopen(), reopen };
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(20);
  }
  throw new Error('Execution lifecycle condition timed out');
}

async function create(services: Awaited<ReturnType<typeof openRunnerServices>>, text: string) {
  return (await services.tasks.create({ idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text }] })).task;
}

async function startedPid(services: Awaited<ReturnType<typeof openRunnerServices>>, taskId: string) {
  const output = await until(async () => (await services.tasks.events(taskId, 0)).items
    .filter(event => event.type === 'task.output').map(event => event.text ?? '').join(''),
  text => /started:\d+/.test(text));
  return Number(/started:(\d+)/.exec(output)![1]);
}

test('graceful shutdown stops active execution and preserves queued work for the next runner', { timeout: 15_000 }, async t => {
  const fixtureState = await fixture(t);
  let services = fixtureState.services;
  const active = await create(services, 'hold');
  await services.execution!.start(active.id, { projectId: 'sample' });
  const pid = await startedPid(services, active.id);
  const queued = await create(services, 'complete');
  await services.execution!.start(queued.id, { projectId: 'sample' });
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');

  services = await fixtureState.reopen(false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await services.tasks.get(active.id)).status, 'interrupted');
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');
  const activeEvents = (await services.tasks.events(active.id, 0)).items;
  assert.equal(activeEvents.filter(event => event.type === 'task.interrupted').length, 1);
  assert.ok(!activeEvents.some(event => event.type === 'task.failed' || event.type === 'task.succeeded'));

  services = await fixtureState.reopen();
  const finished = await until(() => services.tasks.get(queued.id), task => ['succeeded', 'failed'].includes(task.status));
  assert.equal(finished.status, 'succeeded');
  assert.equal((await services.tasks.get(active.id)).status, 'interrupted');
  assert.equal((await services.tasks.events(queued.id, 0)).items.filter(event => event.type === 'task.running').length, 1);
});

test('cancellation stops the previous provider before admitting the next queued execution', { timeout: 15_000 }, async t => {
  const { services } = await fixture(t);
  const active = await create(services, 'hold');
  await services.execution!.start(active.id, { projectId: 'sample' });
  const pid = await startedPid(services, active.id);
  const queued = await create(services, `check-stopped:${pid}`);
  await services.execution!.start(queued.id, { projectId: 'sample' });
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');
  assert.equal((await services.execution!.cancel(active.id)).status, 'cancelled');
  const finished = await until(() => services.tasks.get(queued.id), task => ['succeeded', 'failed'].includes(task.status));
  assert.equal(finished.status, 'succeeded');
  const output = (await services.tasks.events(queued.id, 0)).items.map(event => event.text ?? '').join('');
  assert.match(output, /prior-alive:false/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await services.tasks.get(active.id)).status, 'cancelled');
  const events = (await services.tasks.events(active.id, 0)).items;
  assert.equal(events.filter(event => event.type === 'task.cancelled').length, 1);
  assert.ok(!events.some(event => ['task.failed', 'task.succeeded', 'task.interrupted'].includes(event.type)));
});

test('restart with execution disabled recovers persisted running work without consuming its queue', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-disabled-recovery-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(directory, runnerId);
  let services: Awaited<ReturnType<typeof openRunnerServices>> | undefined;
  t.after(async () => {
    await services?.close();
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const,
    parts: [{ type: 'text' as const, text: 'Persisted work' }] });
  const active = (await repository.createTask(input())).task;
  const queued = (await repository.createTask(input())).task;
  await repository.queueTask(active.id, 'sample');
  await repository.queueTask(queued.id, 'sample');
  assert.equal((await repository.claimNextTask())?.id, active.id);
  // Persist exactly the durable state left by an interrupted runner. Repository
  // close releases storage ownership without applying application recovery.
  await repository.close();
  services = await openRunnerServices(directory, runnerId);
  assert.equal(services.execution, undefined);
  assert.equal((await services.tasks.get(active.id)).status, 'interrupted');
  assert.equal((await services.tasks.get(queued.id)).status, 'queued');
  assert.equal((await services.tasks.events(active.id, 0)).items.filter(event => event.type === 'task.interrupted').length, 1);
});
