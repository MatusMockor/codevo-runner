import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CloneJob } from '../src/domain/project-clone.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer clone-http-test-token';

test('HTTP clone persists projects, replays admission, cancels work and restores history', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codevo-clone-http-'));
  const source = join(dir, 'source');
  const bin = join(dir, 'bin');
  const projectsRoot = join(dir, 'Developer');
  const oldPath = process.env.PATH;
  const oldFixture = process.env.CODEVO_TEST_REPOSITORY;
  let app: Awaited<ReturnType<typeof createRunnerApplication>> | undefined;
  t.after(async () => {
    await app?.close();
    if (oldPath === undefined) delete process.env.PATH;
    if (oldPath !== undefined) process.env.PATH = oldPath;
    if (oldFixture === undefined) delete process.env.CODEVO_TEST_REPOSITORY;
    if (oldFixture !== undefined) process.env.CODEVO_TEST_REPOSITORY = oldFixture;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(source); await mkdir(bin);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'file.txt'), 'original\n');
  git('add', '.'); git('commit', '-m', 'Initial');
  // Only external SSH and provider processes are substituted. HTTP, SQLite,
  // registration, clone and worktree creation use production collaborators.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec git-upload-pack "$CODEVO_TEST_REPOSITORY"\n', { mode: 0o700 });
  const executable = join(bin, 'provider');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => { fs.appendFileSync('file.txt', 'agent change\\n'); console.log(JSON.stringify({ type: 'thread.started', thread_id: '${randomUUID()}' })); console.log(JSON.stringify({ type: 'turn.completed' })); });
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.CODEVO_TEST_REPOSITORY = source;
  const runnerId = randomUUID();
  async function start() {
    const services = await openRunnerServices(join(dir, 'data'), runnerId, {
      projects: [], projectsRoot, providers: [new CliProviderExecutor('codex', { executable })],
    });
    app = await createRunnerApplication({ runnerId, name: 'Clone HTTP test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    await app.listen(0, '127.0.0.1');
    return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }
  let url = await start();
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const post = (path: string, value?: unknown) => fetch(`${url}${path}`, { method: 'POST',
    headers: { authorization, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  async function waitClone(id: string, status: CloneJob['status']) {
    let job: CloneJob | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      job = await (await get(`/v1/project-clones/${id}`)).json() as CloneJob;
      if (job.status === status) return job;
      await delay(20);
    }
    assert.fail(`Expected ${status}, received ${JSON.stringify(job)}`);
  }
  assert.equal((await (await get('/v1/runner')).json()).capabilities.projectCloning, true);
  const input = { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name: 'project' };
  for (const [path, method] of [['/v1/projects/clone', 'POST'], [`/v1/project-clones/${randomUUID()}`, 'GET'], [`/v1/project-clones/${randomUUID()}/cancel`, 'POST']]) {
    assert.equal((await fetch(`${url}${path}`, { method })).status, 401);
  }
  for (const invalid of [{}, { ...input, name: '../escape' }, { ...input, url: 'file:///tmp/repo' }, { ...input, path: '/tmp/unsafe' }, { ...input, branch: '--config=unsafe' }]) {
    assert.equal((await post('/v1/projects/clone', invalid)).status, 400);
  }
  assert.equal((await get('/v1/projects/clone')).status, 405);
  assert.equal((await post('/v1/projects/clone?unsafe=true', input)).status, 404);
  const created = await post('/v1/projects/clone', input);
  assert.equal(created.status, 202);
  const job = await created.json() as CloneJob;
  assert.ok(job.id);
  const replay = await post('/v1/projects/clone', input);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, job.id);
  assert.equal((await post('/v1/projects/clone', { ...input, name: 'different' })).status, 409);
  const done = await waitClone(job.id, 'succeeded');
  assert.deepEqual(done.project, { id: 'project', name: 'project' });
  assert.equal(await readFile(join(projectsRoot, 'project', 'file.txt'), 'utf8'), 'original\n');
  assert.deepEqual(await (await get('/v1/projects')).json(), { items: [done.project] });
  assert.equal((await post('/v1/projects/clone', { ...input, idempotencyKey: randomUUID() })).status, 409);
  const draft = await (await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Update file' }] })).json();
  assert.equal((await post(`/v1/tasks/${draft.task.id}/start`, { projectId: 'project' })).status, 202);
  let taskStatus = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    taskStatus = (await (await get(`/v1/tasks/${draft.task.id}`)).json()).status;
    if (taskStatus === 'succeeded' || taskStatus === 'failed') break;
    await delay(20);
  }
  assert.equal(taskStatus, 'succeeded');
  assert.match((await (await get(`/v1/tasks/${draft.task.id}/diff`)).json()).patch, /agent change/);
  assert.equal(await readFile(join(projectsRoot, 'project', 'file.txt'), 'utf8'), 'original\n');
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho started > "$CODEVO_TEST_REPOSITORY/transport-started"\nsleep 30\n');
  const pending = await (await post('/v1/projects/clone', { ...input, idempotencyKey: randomUUID(), name: 'cancel-me' })).json() as CloneJob;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await readFile(join(source, 'transport-started'), 'utf8').catch(() => '') === 'started\n') break;
    await delay(20);
  }
  assert.equal(await readFile(join(source, 'transport-started'), 'utf8'), 'started\n');
  assert.equal((await post(`/v1/project-clones/${pending.id}/cancel`, {})).status, 400);
  const cancelled = await post(`/v1/project-clones/${pending.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  await app!.close(); app = undefined;
  url = await start();
  assert.deepEqual(await (await get(`/v1/project-clones/${job.id}`)).json(), done);
  assert.equal((await (await get(`/v1/project-clones/${pending.id}`)).json()).status, 'cancelled');
  assert.deepEqual(await (await get('/v1/projects')).json(), { items: [done.project] });
  assert.deepEqual(await readdir(projectsRoot), ['project']);
  assert.equal((await (await post('/v1/projects/clone', input)).json()).id, job.id);
});
