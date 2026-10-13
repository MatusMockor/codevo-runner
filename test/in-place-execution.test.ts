import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openRunnerServices } from '../src/runtime.js';
import { folderProjectRunner, NOT_REPOSITORY } from './folder-project-fixture.js';

const exec = promisify(execFile);
test('in-place execution and continued turns preserve checkout edits and source-backed review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-direct-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  await writeFile(join(source, 'tracked.txt'), 'user dirty\n');
  await writeFile(join(source, 'untracked.txt'), 'user file');
  let calls = 0;
  const sessionId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), randomUUID(), {
    projects: [{ id: 'project', name: 'Project', path: source }],
    providers: [{ provider: 'claude', supportsAttachments: false, execute: async request => {
      calls++;
      assert.equal(request.cwd, await realpath(source));
      assert.ok(request.cwdIdentity);
      assert.equal(request.task.isolation, 'in-place');
      assert.equal(await readFile(join(request.cwd, 'tracked.txt'), 'utf8'), 'user dirty\n');
      assert.equal(await readFile(join(request.cwd, 'untracked.txt'), 'utf8'), 'user file');
      await writeFile(join(request.cwd, 'preview.html'), '<!doctype html><p>Source preview</p>');
      return { exitCode: 0, sessionId };
    } }],
  });
  t.after(async () => { await services.close(); await rm(root, { recursive: true, force: true }); });
  const message = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Work' }] });
  const task = (await services.tasks.create({ ...message(), provider: 'claude', isolation: 'in-place' })).task;
  await services.execution!.start(task.id, { projectId: 'project' });
  async function finished(id: string) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await services.tasks.get(id);
      if (!['queued', 'running'].includes(current.status)) { assert.equal(current.status, 'succeeded'); return; }
      await delay(20);
    }
    assert.fail('Task did not finish');
  }
  await finished(task.id);
  const next = await services.execution!.continue(task.id, message());
  await finished(next.task.id);
  assert.equal(calls, 2);
  assert.match((await services.execution!.diff(next.task.id)).patch, /user dirty/);
  const files = await services.execution!.files(next.task.id);
  assert.ok(JSON.stringify(files).includes('untracked.txt'));
});

test('a folder project runs every turn in the folder itself and stays a folder through git init and a restart', { timeout: 60_000 }, async t => {
  const state = await folderProjectRunner(t);
  const folder = await state.registerFolder('workspace');
  const registered = await state.gitLaunches();
  const live = await lstat(folder);
  const sessionId = randomUUID();
  const turns: { cwd: string; isolation?: string; identity?: Readonly<{ dev: number; ino: number }>; resumed?: string }[] = [];
  state.provider(async request => {
    turns.push({ cwd: request.cwd, isolation: request.task.isolation, identity: request.cwdIdentity, resumed: request.resumeSessionId });
    await writeFile(join(request.cwd, `turn-${turns.length}.txt`), 'agent edit\n');
    if (turns.length === 2) {
      await exec(state.git, ['init', '-q', '-b', 'main', request.cwd]);
      await exec(state.git, ['-C', request.cwd, 'add', '.']);
      await exec(state.git, ['-C', request.cwd, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', 'agent commit']);
    }
    return { exitCode: 0, sessionId };
  });
  const first = await state.run('workspace');
  assert.equal(first.status, 'succeeded');
  assert.equal(first.isolation, 'in-place');
  const second = await state.next(first.id);
  assert.equal(second.status, 'succeeded');
  assert.equal((await lstat(join(folder, '.git'))).isDirectory(), true);
  const third = await state.next(second.id);
  assert.equal(third.status, 'succeeded');
  assert.deepEqual(await (await state.get(`/v1/tasks/${third.id}/resume`)).json(), { available: true, reason: null });
  const inFolder = { cwd: folder, isolation: 'in-place', identity: { dev: live.dev, ino: live.ino } };
  assert.deepEqual(turns.slice(0, 3), [{ ...inFolder, resumed: undefined }, { ...inFolder, resumed: sessionId }, { ...inFolder, resumed: sessionId }]);
  for (const turn of [1, 2, 3]) assert.equal(await readFile(join(folder, `turn-${turn}.txt`), 'utf8'), 'agent edit\n');
  const stillFolder = async (runner: Pick<typeof state, 'get' | 'owner' | 'announced'>, taskId: string) => {
    assert.deepEqual(await (await runner.get('/v1/projects', runner.announced)).json(), { items: [{ id: 'workspace', name: 'workspace', kind: 'folder' }] });
    assert.deepEqual(await (await runner.get('/v1/projects')).json(), { items: [{ id: 'workspace', name: 'workspace' }] });
    for (const route of ['/v1/projects/workspace/git/status', '/v1/projects/workspace/git/branches', `/v1/tasks/${taskId}/git/status`, `/v1/tasks/${taskId}/diff`, `/v1/tasks/${taskId}/files`]) {
      const reply = await runner.get(route);
      assert.equal(reply.status, 409, route);
      assert.deepEqual(await reply.json(), NOT_REPOSITORY, route);
    }
    await assert.rejects(lstat(join(folder, '.git', 'refs', 'codevo')), { code: 'ENOENT' });
    assert.deepEqual(await state.gitLaunches(), registered);
  };
  await stillFolder(state, third.id);

  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  state.provider(async request => {
    turns.push({ cwd: request.cwd, isolation: request.task.isolation, identity: request.cwdIdentity, resumed: request.resumeSessionId });
    if (turns.length === 4) await held;
    return { exitCode: 0, sessionId };
  });
  await state.close();
  const restarted = await state.open();
  const continued = await restarted.post(`/v1/tasks/${third.id}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'After restart' }] });
  assert.equal(continued.status, 202);
  const fourth = (await continued.json() as { task: { id: string } }).task.id;
  for (let attempt = 0; attempt < 500 && turns.length < 4; attempt++) await delay(20);
  assert.equal(turns.length, 4);
  const queued = await restarted.post(`/v1/tasks/${fourth}/pending`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Queued meanwhile' }] });
  assert.equal(queued.status, 202);
  assert.equal(((await (await restarted.get(`/v1/tasks/${fourth}/pending`)).json()) as { items: unknown[] }).items.length, 1);
  release();
  assert.equal((await restarted.settled(fourth)).status, 'succeeded');
  for (let attempt = 0; attempt < 500 && turns.length < 5; attempt++) await delay(20);
  assert.deepEqual(turns.slice(3), [{ ...inFolder, resumed: sessionId }, { ...inFolder, resumed: sessionId }]);
  for (let attempt = 0; attempt < 500 && restarted.services.execution!.working; attempt++) await delay(20);
  assert.deepEqual(await (await restarted.get(`/v1/tasks/${fourth}/pending`)).json(), { items: [] });
  await stillFolder(restarted, fourth);
});

test('two threads run at the same time in one folder project', { timeout: 30_000 }, async t => {
  const state = await folderProjectRunner(t);
  const folder = await state.registerFolder('workspace');
  let active = 0, peak = 0;
  let meet: () => void = () => undefined;
  const together = new Promise<void>(resolve => { meet = resolve; });
  const cwds: string[] = [];
  state.provider(async request => {
    cwds.push(request.cwd);
    active++;
    peak = Math.max(peak, active);
    if (active === 2) meet();
    await together;
    await writeFile(join(request.cwd, `${request.task.id}.txt`), 'thread\n');
    active--;
    return { exitCode: 0, sessionId: request.resumeSessionId ?? randomUUID() };
  });
  const threads = await Promise.all([state.run('workspace'), state.run('workspace')]);
  assert.deepEqual(threads.map(thread => thread.status), ['succeeded', 'succeeded']);
  assert.deepEqual([peak, cwds], [2, [folder, folder]]);
  for (const thread of threads) {
    assert.equal(await readFile(join(folder, `${thread.id}.txt`), 'utf8'), 'thread\n');
    const continued = await state.next(thread.id);
    assert.deepEqual([continued.status, await state.failure(continued.id)], ['succeeded', undefined]);
  }
  assert.equal(cwds.length, 4);
});

test('a folder replaced by another directory fails its thread closed while a new thread uses the new folder', { timeout: 30_000 }, async t => {
  const state = await folderProjectRunner(t);
  const folder = await state.registerFolder('workspace');
  const cwds: string[] = [];
  state.provider(async request => {
    cwds.push(request.cwd);
    return { exitCode: 0, sessionId: randomUUID() };
  });
  const first = await state.run('workspace');
  assert.equal(first.status, 'succeeded');
  await rename(folder, `${folder}-original`);
  await mkdir(folder);
  await writeFile(join(folder, 'replacement.txt'), 'keep me\n');
  const refused = await state.post(`/v1/tasks/${first.id}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Continue' }] });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'conflict' });
  assert.deepEqual(await (await state.get(`/v1/tasks/${first.id}/resume`)).json(), { available: false, reason: 'session_unavailable' });
  assert.equal(cwds.length, 1);
  assert.equal(await readFile(join(folder, 'replacement.txt'), 'utf8'), 'keep me\n');
  assert.equal((await state.run('workspace')).status, 'succeeded');
  assert.deepEqual(cwds, [folder, folder]);
});

test('a folder project thread syncs instructions, takes steering, keeps an artifact and offers ports and a terminal', { timeout: 30_000 }, async t => {
  const state = await folderProjectRunner(t);
  const folder = await state.registerFolder('workspace');
  const launched = await state.gitLaunches();
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed: { rules?: string; steered: string[] } = { steered: [] };
  state.provider(async request => {
    observed.rules = await readFile(join(request.cwd, 'CLAUDE.md'), 'utf8');
    await writeFile(join(request.cwd, 'preview.html'), '<!doctype html><p>Folder preview</p>');
    request.onSteeringReady?.(async input => { observed.steered.push(input.prompt); });
    await held;
    return { exitCode: 0, sessionId: randomUUID() };
  });
  const created = await state.post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'claude', isolation: 'in-place', parts: [{ type: 'text', text: 'Work' }],
    instructions: { version: 1, files: [{ scope: 'project', path: 'CLAUDE.md', content: 'folder rules\n' }] } });
  assert.equal(created.status, 201);
  const task = (await created.json() as { task: { id: string } }).task;
  assert.equal((await state.post(`/v1/tasks/${task.id}/start`, { projectId: 'workspace' })).status, 202);
  for (let attempt = 0; attempt < 500 && observed.rules === undefined; attempt++) await delay(20);
  const steer = await state.post(`/v1/tasks/${task.id}/steer`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Also check the notes' }] });
  assert.equal(steer.status, 200);
  assert.equal((await steer.json() as { status: string }).status, 'accepted');
  release();
  assert.equal((await state.settled(task.id)).status, 'succeeded');
  assert.deepEqual(observed, { rules: 'folder rules\n', steered: ['Also check the notes'] });
  assert.equal(await readFile(join(folder, 'CLAUDE.md'), 'utf8'), 'folder rules\n');
  const artifact = await state.post(`/v1/tasks/${task.id}/artifacts`, { path: 'preview.html' });
  assert.equal(artifact.status, 201);
  const stored = await artifact.json() as { artifact: { id: string } };
  const content = await state.get(`/v1/tasks/${task.id}/artifacts/${stored.artifact.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(await content.text(), '<!doctype html><p>Folder preview</p>');
  if (process.platform === 'linux') {
    for (const route of ['/v1/projects/workspace/ports', `/v1/tasks/${task.id}/ports`]) assert.equal((await state.get(route)).status, 200, route);
  }
  for (const scope of [{}, { taskId: task.id }]) {
    const opened = await state.post('/v1/projects/workspace/terminals', { cols: 80, rows: 24, ...scope });
    assert.equal(opened.status, 200);
    const session = await opened.json() as { id: string };
    const query = 'taskId' in scope ? `?taskId=${task.id}` : '';
    assert.equal((await fetch(`${state.url}/v1/projects/workspace/terminals/${session.id}${query}`, { method: 'DELETE', headers: state.owner })).status, 200);
  }
  assert.deepEqual(await state.gitLaunches(), launched);
});

test('a configured project that collides with a persisted folder project fails every project lookup closed until it is removed', { timeout: 30_000 }, async t => {
  const state = await folderProjectRunner(t);
  const folder = await state.registerFolder('workspace');
  await state.registerFolder('other');
  const thread = await state.run('workspace');
  assert.equal(thread.status, 'succeeded');
  const launched = await state.gitLaunches();
  await state.close();
  const cwds: string[] = [];
  state.provider(async request => {
    cwds.push(request.cwd);
    return { exitCode: 0, sessionId: request.resumeSessionId ?? randomUUID() };
  });
  const collided = await state.open([{ id: 'workspace', name: 'Workspace', path: folder }]);
  assert.equal((await collided.get('/v1/runner')).status, 200);
  const draft = await collided.draft('in-place');
  const refusals = [await collided.get('/v1/projects'), await collided.get('/v1/projects', collided.announced),
    await collided.post(`/v1/tasks/${draft.id}/start`, { projectId: 'workspace' }), await collided.post(`/v1/tasks/${draft.id}/start`, { projectId: 'other' }),
    await collided.post(`/v1/tasks/${thread.id}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Continue' }] }),
    await collided.get('/v1/projects/workspace/git/status'), await collided.get('/v1/projects/workspace/repository-identity'),
    await collided.get('/v1/projects/workspace/surface/capabilities'), await collided.get(`/v1/tasks/${thread.id}/files`)];
  for (const reply of refusals) {
    assert.equal(reply.status, 409, reply.url);
    assert.deepEqual(await reply.json(), { error: 'conflict' }, reply.url);
  }
  assert.equal((await collided.task(draft.id)).status, 'draft');
  assert.deepEqual(await (await collided.get(`/v1/tasks/${thread.id}/resume`)).json(), { available: false, reason: 'session_unavailable' });
  assert.deepEqual([cwds.length, await state.gitLaunches()], [0, launched]);
  await collided.close();
  const restored = await state.open();
  assert.deepEqual(await (await restored.get('/v1/projects', restored.announced)).json(),
    { items: [{ id: 'other', name: 'other', kind: 'folder' }, { id: 'workspace', name: 'workspace', kind: 'folder' }] });
  assert.equal((await restored.next(thread.id)).status, 'succeeded');
  assert.deepEqual([cwds, await state.gitLaunches()], [[folder], launched]);
});
