import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ProjectCloner } from '../src/application/clone-ports.js';
import { ProjectCloneService } from '../src/application/project-clone-service.js';
import type { ProjectFolderInspector } from '../src/application/project-registration-ports.js';
import { ProjectRegistrationService } from '../src/application/project-registration-service.js';
import type { RegisteredProject } from '../src/domain/execution.js';
import type { CloneJob } from '../src/domain/project-clone.js';
import type { ProjectRegistration } from '../src/domain/project-registration.js';
import { GitCloneAdapter } from '../src/infrastructure/projects/clone.js';
import { ConfiguredProjectRegistry } from '../src/infrastructure/projects/index.js';
import { GitProjectFolderInspector } from '../src/infrastructure/projects/project-folder.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { eventually, ManualClock } from './maintenance-fixture.js';

const authorization = 'Bearer registration-test-token';
const route = '/v1/projects/register';
const registered = (name: string, created: boolean) => ({ status: 'registered', project: { id: name, name }, created });
const rejected = (reason: string) => ({ status: 'rejected', reason });

type Space = Awaited<ReturnType<typeof space>>;

/** The data directory sits beneath the projects root, as it does in production. */
async function space(t: TestContext) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'codevo-register-')));
  const closers: (() => Promise<unknown> | void)[] = [() => rm(temp, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
  });
  const projectsRoot = join(temp, 'Developer');
  const dataDir = join(projectsRoot, '.agent', 'codevo-runner');
  await mkdir(dataDir, { recursive: true });
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const repository = async (...segments: string[]) => {
    const path = join(projectsRoot, ...segments);
    await mkdir(path, { recursive: true });
    execFileSync(git, ['init', '-q', '-b', 'main', path], { stdio: 'ignore' });
    return path;
  };
  // Only an external process is substituted, and only to hold it at a known point.
  const hold = async (program: string, command: string) => {
    const bin = join(temp, `${program}-bin`), gate = join(temp, `${program}-gate`), launches = join(temp, `${program}-launches`);
    await mkdir(bin);
    await writeFile(join(bin, program), `#!/bin/sh\necho launched >> "${launches}"\nwhile [ ! -e "${gate}" ]; do sleep 0.02; done\nexec ${command}\n`, { mode: 0o700 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    closers.push(() => { process.env.PATH = path; });
    return {
      launched: async () => (await readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
      release: () => writeFile(gate, ''),
    };
  };
  const holdGit = () => hold('git', `"${git}" "$@"`);
  const holdCloneTransport = async () => {
    const source = join(temp, 'source');
    await mkdir(source);
    await writeFile(join(source, 'file.txt'), 'original\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'Initial']])
      execFileSync(git, args, { cwd: source, stdio: 'ignore' });
    return hold('ssh', `git-upload-pack "${source}"`);
  };
  return { temp, projectsRoot, dataDir, closers, repository, holdGit, holdCloneTransport };
}

async function runner(t: TestContext, configure: (state: Space) => Promise<readonly RegisteredProject[]> = async () => [], execution = true) {
  const state = await space(t);
  const runnerId = randomUUID();
  const options = execution ? { projects: await configure(state), projectsRoot: state.projectsRoot, providers: [] } : undefined;
  const services = await openRunnerServices(state.dataDir, runnerId, options, undefined, { clock: new ManualClock() });
  state.closers.push(() => services.close());
  const app = await createRunnerApplication({ runnerId, name: 'Registration test', protocolVersion: 1,
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
  state.closers.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const owner: Record<string, string> = { authorization, 'x-codevo-runner-id': runnerId };
  const post = (path: string, value: unknown, headers = owner) => fetch(`${url}${path}`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const register = async (path: string, name: string) => {
    const reply = await post(route, { path, name });
    assert.equal(reply.status, 200, `${path} ${name}`);
    return await reply.json() as ProjectRegistration;
  };
  const projects = async () => (await (await fetch(`${url}/v1/projects`, { headers: owner })).json() as { items: unknown[] }).items;
  return { ...state, services, url, owner, post, register, projects };
}

async function application(t: TestContext, inspect: (real: ProjectFolderInspector) => ProjectFolderInspector = real => real, cloner?: (state: Space) => ProjectCloner) {
  const state = await space(t);
  const store = await openSqliteRepository(state.dataDir, randomUUID());
  state.closers.push(() => store.close());
  const configured = new ConfiguredProjectRegistry([]);
  const clones = new ProjectCloneService(store, cloner?.(state) ?? new GitCloneAdapter(state.projectsRoot), configured);
  state.closers.push(() => clones.close());
  const registration = new ProjectRegistrationService(store, inspect(new GitProjectFolderInspector(state.projectsRoot, state.dataDir)), configured, clones);
  state.closers.push(() => registration.close());
  return { ...state, store, clones, registration };
}

test('an existing repository registers once, is listed without its path and replays for the same folder', async t => {
  const state = await runner(t, async host => [
    { id: 'host', name: 'Host project', path: await host.repository('configured') },
    { id: 'api', name: 'Backend', path: await host.repository('backend') },
  ]);
  const hosts = [{ id: 'host', name: 'Host project' }, { id: 'api', name: 'Backend' }];
  const folder = await state.repository('efabrica', 'ebox-crm');
  const reply = await state.post(route, { path: folder, name: 'ebox-crm' });
  assert.equal(reply.status, 200);
  const body = await reply.text();
  assert.deepEqual(JSON.parse(body), registered('ebox-crm', true));
  assert.equal(body.includes(state.temp), false);
  const listed = [...hosts, { id: 'ebox-crm', name: 'ebox-crm' }];
  assert.deepEqual(await state.projects(), listed);
  assert.deepEqual(await (await fetch(`${state.url}/v1/projects/ebox-crm/repository-identity`, { headers: state.owner })).json(), { repositoryKey: null });

  for (const name of ['ebox-crm', 'renamed', 'host', 'Backend']) assert.deepEqual(await state.register(folder, name), registered('ebox-crm', false), name);
  assert.deepEqual(await state.register(`${folder}/`, 'ebox-crm'), registered('ebox-crm', false));
  assert.deepEqual(await state.register(join(state.projectsRoot, 'configured'), 'anything'), { status: 'registered', project: hosts[0], created: false });

  const other = await state.repository('efabrica', 'other');
  for (const name of ['ebox-crm', 'host', 'api', 'Backend']) assert.deepEqual(await state.register(other, name), rejected('name_taken'), name);
  assert.deepEqual(await state.projects(), listed);
  assert.deepEqual(await state.register(other, 'other'), registered('other', true));
});

test('folders that are not a working tree root, or that belong to the runner, are rejected', async t => {
  const state = await runner(t);
  const plain = join(state.projectsRoot, 'plain');
  await mkdir(plain);
  const repository = await state.repository('team', 'repo');
  await mkdir(join(repository, 'packages', 'app'), { recursive: true });
  const bare = join(state.projectsRoot, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
  for (const path of [plain, join(repository, 'packages'), join(repository, 'packages', 'app'), join(repository, '.git'), bare, join(state.projectsRoot, 'team')])
    assert.deepEqual(await state.register(path, 'candidate'), rejected('not_git_root'), path);
  const worktree = await state.repository('.agent', 'codevo-runner', 'workspaces', 'task');
  for (const path of [state.projectsRoot, state.dataDir, join(state.dataDir, 'workspaces'), worktree])
    assert.deepEqual(await state.register(path, 'candidate'), rejected('not_allowed'), path);
  assert.deepEqual(await state.projects(), []);
  assert.deepEqual(await state.register(await state.repository('.agent', 'tools'), 'tools'), registered('tools', true));
});

test('malformed requests, foreign owners and paths outside the projects root never register', async t => {
  const state = await runner(t);
  const repository = await state.repository('repo');
  const outside = join(state.temp, 'outside');
  await mkdir(outside);
  execFileSync('git', ['init', '-q', outside], { stdio: 'ignore' });
  await symlink(repository, join(state.projectsRoot, 'alias'));
  await symlink(state.projectsRoot, join(state.projectsRoot, 'loop'));
  await writeFile(join(state.projectsRoot, 'file'), '');
  const name = 'repo';
  const invalid: unknown[] = [
    { path: outside, name }, { path: `${state.projectsRoot}/../outside`, name }, { path: join(state.projectsRoot, 'alias'), name },
    { path: join(state.projectsRoot, 'loop', 'repo'), name }, { path: join(state.projectsRoot, 'missing'), name },
    { path: join(state.projectsRoot, 'file'), name }, { path: 'repo', name }, { path: `/${'x'.repeat(4096)}`, name }, { path: `${repository}\n`, name },
    { path: repository, name, extra: true }, { path: repository, name, idempotencyKey: randomUUID() }, { path: repository }, { name }, {}, [], null, name,
    { path: repository, name: 7 }, { path: 7, name }, { path: null, name }, { path: repository, name: null },
    ...['', '-repo', '_repo', 'a b', 'a/b', '..', 'x'.repeat(65), 'repo\n', 'répo'].map(bad => ({ path: repository, name: bad })),
  ];
  for (const value of invalid) {
    const reply = await state.post(route, value);
    assert.equal(reply.status, 400, JSON.stringify(value));
    assert.deepEqual(await reply.json(), { error: 'invalid_input' });
  }
  const large = await state.post(route, { path: repository, name, padding: 'x'.repeat(8192) });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: 'too_large' });
  const text = await fetch(`${state.url}${route}`, { method: 'POST', headers: { ...state.owner, 'content-type': 'text/plain' }, body: JSON.stringify({ path: repository, name }) });
  assert.equal(text.status, 415);
  assert.equal((await fetch(`${state.url}${route}`, { method: 'POST', body: '{bad json' })).status, 401);
  for (const identity of [undefined, randomUUID()]) {
    const reply = await state.post(route, { path: repository, name }, identity ? { authorization, 'x-codevo-runner-id': identity } : { authorization });
    assert.equal(reply.status, 409, String(identity));
    assert.deepEqual(await reply.json(), { error: 'runner_identity_mismatch' });
  }
  assert.equal((await fetch(`${state.url}${route}`, { headers: state.owner })).status, 405);
  assert.equal((await state.post(`${route}?force=true`, { path: repository, name })).status, 404);
  assert.equal((await state.post(`${route}/`, { path: repository, name })).status, 404);
  assert.deepEqual(await state.projects(), []);
  assert.deepEqual(await state.register(repository, name), registered(name, true));
});

test('registration is not offered when execution is disabled', async t => {
  const state = await runner(t, undefined, false);
  const reply = await state.post(route, { path: await state.repository('repo'), name: 'repo' });
  assert.equal(reply.status, 404);
  assert.deepEqual(await reply.json(), { error: 'not_found' });
});

test('registrations share the 32-project limit with configured projects', { timeout: 60_000 }, async t => {
  const state = await runner(t, async host => [{ id: 'host', name: 'Host', path: await host.repository('host') }]);
  for (let index = 0; index < 31; index++) {
    const name = `repo-${index}`;
    assert.deepEqual(await state.register(await state.repository(name), name), registered(name, true));
  }
  assert.deepEqual(await state.register(await state.repository('overflow'), 'overflow'), rejected('limit_reached'));
  assert.deepEqual(await state.register(join(state.projectsRoot, 'overflow'), 'repo-0'), rejected('name_taken'));
  assert.deepEqual(await state.register(join(state.projectsRoot, 'repo-0'), 'overflow'), registered('repo-0', false));
  assert.equal((await state.projects()).length, 32);
});

test('concurrent registrations of one name admit exactly one folder and one creation per folder', async t => {
  const state = await runner(t);
  const folders = [await state.repository('first'), await state.repository('second'), await state.repository('third')];
  const contested = await Promise.all(folders.map(folder => state.register(folder, 'shared')));
  assert.deepEqual(contested.map(result => JSON.stringify(result)).sort(), [registered('shared', true), rejected('name_taken'), rejected('name_taken')].map(result => JSON.stringify(result)).sort());
  assert.deepEqual(await state.projects(), [{ id: 'shared', name: 'shared' }]);
  const loser = folders[contested.findIndex(result => result.status === 'rejected')]!;
  const repeated = await Promise.all(['retry', 'retry', 'retry'].map(name => state.register(loser, name)));
  assert.deepEqual(repeated.map(result => JSON.stringify(result)).sort(), [registered('retry', false), registered('retry', false), registered('retry', true)].map(result => JSON.stringify(result)).sort());
  assert.equal((await state.projects()).length, 2);
});

async function store(t: TestContext, changed: () => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codevo-register-db-'));
  const repository = await openSqliteRepository(directory, randomUUID(), changed);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const clone = (name: string, parentPath?: string) => repository.createClone({ idempotencyKey: randomUUID(),
    url: 'https://example.com/team/repo.git', name, ...(parentPath === undefined ? {} : { parentPath }) });
  return { repository, clone };
}

test('the registration transaction honours clone reservations and stores the shape clones store', async t => {
  let changes = 0;
  const { repository, clone } = await store(t, () => { changes++; });
  const project = (name: string) => ({ id: name, name, path: `/srv/projects/existing/${name}` });
  const register = (value: RegisteredProject, configured: readonly { id: string; name: string }[] = []) => repository.registerManagedProject(value, configured, '/srv/projects');
  const reservation = await clone('cloning');
  changes = 0;
  assert.deepEqual(await register(project('cloning')), rejected('name_taken'));
  assert.deepEqual(await register(project('app'), [{ id: 'app', name: 'Application' }]), rejected('name_taken'));
  assert.deepEqual(await register(project('app'), [{ id: 'host', name: 'app' }]), rejected('name_taken'));
  const hosts = Array.from({ length: 31 }, (_, index) => ({ id: `host-${index}`, name: `Host ${index}` }));
  assert.deepEqual(await register(project('app'), hosts), rejected('limit_reached'));
  assert.deepEqual(await register(project('app'), hosts.slice(1)), registered('app', true));
  assert.deepEqual(await register(project('late'), hosts.slice(1)), rejected('limit_reached'));
  await assert.rejects(register({ id: 'one', name: 'two', path: '/srv/projects/existing/one' }), { code: 'invalid_input' });
  assert.equal(changes, 1);
  assert.deepEqual(await repository.listManagedProjects(), [project('app')]);
  assert.deepEqual(await register({ ...project('renamed'), path: project('app').path }, hosts), registered('app', false));
  assert.equal(changes, 1);
  await assert.rejects(clone('app'), { code: 'conflict' });
  await repository.cancelClone(reservation.id);
  assert.deepEqual(await register(project('cloning')), registered('cloning', true));
  assert.deepEqual(await repository.listManagedProjects(), [project('app'), project('cloning')]);
});

test('the registration transaction refuses the destination of a queued or running clone', async t => {
  const { repository, clone } = await store(t);
  const register = (name: string, path: string) => repository.registerManagedProject({ id: name, name, path }, [], '/srv/projects');
  const rooted = await clone('foo');
  const nested = await clone('bar', '/srv/projects/team/');
  const refused = async (status: CloneJob['status']) => {
    for (const job of [rooted, nested]) assert.equal((await repository.getClone(job.id)).status, status);
    for (const name of ['mine', 'foo']) assert.deepEqual(await register(name, '/srv/projects/foo'), rejected('not_allowed'), `${status} ${name}`);
    assert.deepEqual(await register('mine', '/srv/projects/team/bar'), rejected('not_allowed'), status);
  };
  await refused('queued');
  await repository.claimClone();
  await repository.claimClone();
  await refused('running');
  assert.deepEqual(await register('team-foo', '/srv/projects/team/foo'), registered('team-foo', true));
  assert.deepEqual(await register('root-bar', '/srv/projects/bar'), registered('root-bar', true));
  assert.deepEqual(await register('foo', '/srv/projects/elsewhere'), rejected('name_taken'));
  await repository.finishClone(rooted.id, 'succeeded', { id: 'foo', name: 'foo', path: '/srv/projects/foo' }, null);
  assert.deepEqual(await register('mine', '/srv/projects/foo'), registered('foo', false));
  await repository.cancelClone(nested.id);
  assert.deepEqual(await register('mine', '/srv/projects/team/bar'), registered('mine', true));
});

test('the folder an active clone is filling cannot be registered until that clone settles', { timeout: 20_000 }, async t => {
  const state = await runner(t);
  const sibling = await state.repository('team', 'foo');
  const occupied = await state.repository('team', 'nested');
  const destination = join(state.projectsRoot, 'foo');
  const ssh = await state.holdCloneTransport();
  const clone = async (name: string, parentPath?: string) => {
    const reply = await state.post('/v1/projects/clone', { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name, ...(parentPath === undefined ? {} : { parentPath }) });
    assert.equal(reply.status, 202);
    return (await reply.json() as CloneJob).id;
  };
  const settles = (id: string, status: CloneJob['status']) => eventually(
    async () => (await (await fetch(`${state.url}/v1/project-clones/${id}`, { headers: state.owner })).json() as CloneJob).status, value => value === status, `clone ${status}`);
  const running = await clone('foo');
  const queued = await clone('nested', join(state.projectsRoot, 'team'));
  await eventually(ssh.launched, launched => launched === 1, 'clone transport');
  for (const name of ['mine', 'foo']) assert.deepEqual(await state.register(destination, name), rejected('not_allowed'), name);
  assert.deepEqual(await state.register(occupied, 'mine'), rejected('not_allowed'));
  assert.deepEqual(await state.register(sibling, 'team-foo'), registered('team-foo', true));
  assert.deepEqual(await state.projects(), [{ id: 'team-foo', name: 'team-foo' }]);
  await ssh.release();
  await settles(running, 'succeeded');
  await settles(queued, 'failed');
  assert.deepEqual(await state.register(destination, 'mine'), registered('foo', false));
  assert.deepEqual(await state.register(occupied, 'mine'), registered('mine', true));
  assert.deepEqual(await state.projects(), [{ id: 'foo', name: 'foo' }, { id: 'mine', name: 'mine' }, { id: 'team-foo', name: 'team-foo' }]);
});

test('a held maintenance lease refuses registration and an in-flight registration refuses the lease', async t => {
  const state = await runner(t);
  const folder = await state.repository('repo');
  const lease = randomUUID();
  assert.equal((await state.post('/v1/maintenance/prepare', { leaseId: lease })).status, 200);
  const fenced = await state.post(route, { path: folder, name: 'repo' });
  assert.equal(fenced.status, 503);
  assert.deepEqual(await fenced.json(), { error: 'busy' });
  assert.deepEqual(await state.projects(), []);
  assert.equal((await fetch(`${state.url}/v1/maintenance/${lease}`, { method: 'DELETE', headers: state.owner })).status, 200);

  const git = await state.holdGit();
  const registration = state.services.projectRegistration!;
  const pending = registration.register({ path: folder, name: 'repo' }, new AbortController().signal);
  await eventually(git.launched, launched => launched === 1, 'git launch');
  assert.equal(registration.working, true);
  const refused = await state.post('/v1/maintenance/prepare', { leaseId: randomUUID() });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'conflict' });
  await git.release();
  assert.deepEqual(await pending, registered('repo', true));
  assert.equal(registration.working, false);
  assert.equal((await state.post('/v1/maintenance/prepare', { leaseId: randomUUID() })).status, 200);
  assert.deepEqual(await state.projects(), [{ id: 'repo', name: 'repo' }]);
});

test('a client that disconnects stops its registration', async t => {
  const state = await runner(t);
  const folder = await state.repository('repo');
  const git = await state.holdGit();
  const client = new AbortController();
  const request = fetch(`${state.url}${route}`, { method: 'POST', signal: client.signal,
    headers: { ...state.owner, 'content-type': 'application/json' }, body: JSON.stringify({ path: folder, name: 'repo' }) });
  await eventually(git.launched, launched => launched === 1, 'git launch');
  assert.equal(state.services.projectRegistration!.working, true);
  client.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await eventually(() => state.services.projectRegistration!.working, working => !working, 'abandoned registration');
  await git.release();
  assert.deepEqual(await state.projects(), []);
});

test('in-flight registrations are bounded, stop on close and none is admitted afterwards', async t => {
  const state = await application(t);
  const folders: string[] = [];
  for (let index = 0; index < 5; index++) folders.push(await state.repository(`repo-${index}`));
  const git = await state.holdGit();
  const signal = new AbortController().signal;
  const held = folders.slice(0, 4).map((path, index) => state.registration.register({ path, name: `repo-${index}` }, signal));
  const settled = Promise.allSettled(held);
  assert.equal(state.registration.working, true);
  await assert.rejects(state.registration.register({ path: folders[4], name: 'repo-4' }, signal), { code: 'busy' });
  await assert.rejects(state.registration.register({ path: folders[4], name: 'repo 4' }, signal), { code: 'invalid_input' });
  await eventually(git.launched, launched => launched === 4, 'git launches');
  await state.registration.close();
  assert.equal(state.registration.working, false);
  for (const result of await settled) assert.equal(result.status === 'rejected' && result.reason.code, 'busy');
  await git.release();
  await assert.rejects(state.registration.register({ path: folders[4], name: 'repo-4' }, signal), { code: 'busy' });
  assert.deepEqual(await state.store.listManagedProjects(), []);
});

test('a folder replaced after its inspection is not registered', async t => {
  let replace = true;
  const state = await application(t, real => ({
    retain: async (path, signal) => {
      const folder = await real.retain(path, signal);
      if (!replace) return folder;
      replace = false;
      await rename(path, `${path}-original`);
      await mkdir(path);
      return folder;
    },
  }));
  const folder = await state.repository('repo');
  const signal = new AbortController().signal;
  await assert.rejects(state.registration.register({ path: folder, name: 'repo' }, signal), { code: 'storage_unavailable' });
  assert.deepEqual(await state.store.listManagedProjects(), []);
  await rm(folder, { recursive: true });
  await rename(`${folder}-original`, folder);
  assert.deepEqual(await state.registration.register({ path: folder, name: 'repo' }, signal), registered('repo', true));
  assert.deepEqual(await state.store.listManagedProjects(), [{ id: 'repo', name: 'repo', path: folder }]);
});

test('a cancelled clone keeps its destination reserved until its rollback has finished', async t => {
  let cloned = false, rollingBack = false;
  let finishRollback: () => void = () => undefined;
  const rollbackHeld = new Promise<void>(resolve => { finishRollback = resolve; });
  // Only the cloner is a double, so its rollback can be held; the clone service, registration and SQLite are real.
  const state = await application(t, undefined, host => ({
    clone: async (input, _jobId, signal) => {
      const path = await host.repository(input.name);
      cloned = true;
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { project: { id: input.name, name: input.name, path }, rollback: async () => { rollingBack = true; await rollbackHeld; await rm(path, { recursive: true }); } };
    },
  }));
  state.closers.push(finishRollback);
  const signal = new AbortController().signal;
  const destination = join(state.projectsRoot, 'foo');
  const register = (name: string) => state.registration.register({ path: destination, name }, signal);
  const job = await state.clones.create({ idempotencyKey: randomUUID(), url: 'https://example.com/team/foo.git', name: 'foo' });
  await eventually(() => cloned, Boolean, 'clone');
  assert.deepEqual(await register('mine'), rejected('not_allowed'));
  assert.equal((await state.clones.cancel(job.id)).status, 'cancelled');
  await eventually(() => rollingBack, Boolean, 'rollback');
  assert.equal((await state.store.getClone(job.id)).status, 'cancelled');
  for (const name of ['mine', 'foo']) assert.deepEqual(await register(name), rejected('not_allowed'), name);
  assert.deepEqual(await state.store.listManagedProjects(), []);
  finishRollback();
  await eventually(() => state.clones.working, working => !working, 'clone cleanup');
  await assert.rejects(register('mine'), { code: 'invalid_input' });
  assert.deepEqual(await state.store.listManagedProjects(), []);
  await state.repository('foo');
  assert.deepEqual(await register('mine'), registered('mine', true));
});

test('a clone cancelled at its transport never leaves the half-cloned folder registered', { timeout: 20_000 }, async t => {
  const state = await runner(t);
  const ssh = await state.holdCloneTransport();
  const destination = join(state.projectsRoot, 'foo');
  const created = await state.post('/v1/projects/clone', { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name: 'foo' });
  assert.equal(created.status, 202);
  const job = await created.json() as CloneJob;
  await eventually(ssh.launched, launched => launched === 1, 'clone transport');
  assert.deepEqual(await state.register(destination, 'mine'), rejected('not_allowed'));
  assert.equal((await fetch(`${state.url}/v1/project-clones/${job.id}/cancel`, { method: 'POST', headers: state.owner })).status, 200);
  const outcomes: string[] = [];
  while (outcomes.length < 500 && outcomes.at(-1) !== 'invalid_input') {
    const body = await (await state.post(route, { path: destination, name: 'mine' })).json() as { status?: string; reason?: string; error?: string };
    outcomes.push(body.error ?? body.reason ?? body.status ?? '');
  }
  assert.equal(outcomes.at(-1), 'invalid_input', outcomes.join());
  assert.equal(outcomes.includes('registered'), false, outcomes.join());
  assert.deepEqual(await state.projects(), []);
});

test('a registration is not admitted once shutdown has begun', async t => {
  const state = await runner(t);
  const folder = await state.repository('repo');
  const registration = state.services.projectRegistration!;
  const closing = state.services.close();
  const attempt = registration.register({ path: folder, name: 'repo' }, new AbortController().signal);
  const admitted = registration.working;
  await assert.rejects(attempt, { code: 'busy' });
  assert.equal(admitted, false);
  await closing;
});

test('a request abandoned during the final folder check does not insert', async t => {
  const client = new AbortController();
  const state = await application(t, real => ({
    retain: async (path, signal) => {
      const folder = await real.retain(path, signal);
      return { ...folder, owned: async () => { const owned = await folder.owned(); client.abort(); return owned; } };
    },
  }));
  const folder = await state.repository('repo');
  await assert.rejects(state.registration.register({ path: folder, name: 'repo' }, client.signal), { name: 'AbortError' });
  assert.deepEqual(await state.store.listManagedProjects(), []);
  assert.deepEqual(await state.registration.register({ path: folder, name: 'repo' }, new AbortController().signal), registered('repo', true));
});

test('an unreadable folder is invalid input rather than a server error', { skip: process.getuid?.() === 0 }, async t => {
  const state = await runner(t);
  const sealed = await state.repository('sealed');
  await mkdir(join(sealed, 'inner'));
  await chmod(sealed, 0o000);
  state.closers.push(() => chmod(sealed, 0o700));
  for (const path of [sealed, join(sealed, 'inner')]) {
    const reply = await state.post(route, { path, name: 'sealed' });
    assert.equal(reply.status, 400, path);
    assert.deepEqual(await reply.json(), { error: 'invalid_input' });
  }
  assert.deepEqual(await state.projects(), []);
});

test('a folder swapped for a symlink while it is selected never surfaces a server error', { timeout: 30_000 }, async t => {
  const state = await runner(t);
  const target = await state.repository('target');
  const folder = join(state.projectsRoot, 'swapped'), parked = `${folder}-parked`;
  await mkdir(folder);
  let swapping = true;
  const swapper = (async () => {
    while (swapping) {
      await rename(folder, parked);
      await symlink(target, folder);
      await unlink(folder);
      await rename(parked, folder);
    }
  })();
  const outcomes = new Map<string, number>();
  try {
    for (let round = 0; round < 300; round++) {
      for (const reply of await Promise.all([0, 1, 2].map(() => state.post(route, { path: folder, name: 'swapped' })))) {
        const body = await reply.json() as { status?: string; reason?: string; error?: string };
        const outcome = `${reply.status} ${body.error ?? body.reason ?? body.status}`;
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      }
    }
  } finally { swapping = false; await swapper; }
  const allowed = ['200 not_git_root', '400 invalid_input', '503 storage_unavailable'];
  assert.deepEqual([...outcomes].filter(([outcome]) => !allowed.includes(outcome)), []);
  assert.deepEqual(await state.projects(), []);
});
