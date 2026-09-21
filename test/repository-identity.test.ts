import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRepositoryKey } from '../src/domain/repository-identity.js';
import { ProjectRepositoryIdentity } from '../src/infrastructure/projects/repository-identity.js';

test('canonical origin identity strips credentials and defaults but preserves authority distinctions', () => {
  for (const value of ['https://token:secret@GitHub.com/OWNER/Repo.git', 'https://user:p%40ss@github.com/Owner/Repo.git///', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com:22/Owner/Repo.git/'])
    assert.equal(canonicalRepositoryKey(value), 'github.com/owner/repo');
  assert.equal(canonicalRepositoryKey('ssh://git@git.example.com:2222/Owner/Repo.git'), 'git.example.com:2222/Owner/Repo');
  assert.equal(canonicalRepositoryKey('https://git.example.com/Owner/Repo.git'), 'git.example.com/Owner/Repo');
  for (const value of ['', '/tmp/repo', 'file:///tmp/repo', 'https://host/a', 'https://example.com/a/../b', 'https://example.com/a//b', 'https://example.com/a?token=secret', 'https://example.com/a#frag', 'https://example.com/a%2fb', 'https://example.com/á', 'https://example.com:0/a', 'https://example.com:65536/a', `https://example.com/${'x'.repeat(2048)}`])
    assert.equal(canonicalRepositoryKey(value), null, value);
});

test('pinned identity reads local origin, excludes includes, accepts absent origin and cancellation', async t => {
  const path = await mkdtemp(join(tmpdir(), 'codevo-identity-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init');
  const reader = new ProjectRepositoryIdentity();
  const project = { id: 'test', name: 'Test', path };
  assert.equal(await reader.read(project), null);
  const included = join(path, 'included-config');
  await writeFile(included, '[remote \"origin\"]\nurl = https://github.com/Foreign/Repo.git\n');
  git('config', 'include.path', included);
  assert.equal(await reader.read(project), null);
  git('config', 'remote.origin.url', 'https://private:secret@github.com/Owner/Repo.git');
  assert.equal(await reader.read(project), 'github.com/owner/repo');
  git('config', 'remote.origin.url', 'https://example.com/owner/../repo');
  assert.equal(await reader.read(project), null);
  await assert.rejects(reader.read(project, AbortSignal.abort()));
  const first = reader.read(project);
  const second = reader.read(project);
  await assert.rejects(reader.read(project), { code: 'busy' });
  await Promise.all([first, second]);
  assert.equal(await reader.read(project), null);
});

test('repository identity HTTP requires exact runner and keeps legacy catalog shape', async t => {
  const { randomUUID } = await import('node:crypto');
  const { openRunnerServices } = await import('../src/runtime.js');
  const { createRunnerApplication } = await import('../src/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'codevo-identity-api-'));
  const runnerId = randomUUID();
  const projectPath = join(directory, 'project');
  execFileSync('git', ['init', projectPath], { stdio: 'ignore' });
  execFileSync('git', ['config', 'remote.origin.url', 'git@github.com:Owner/Repo.git'], { cwd: projectPath });
  const services = await openRunnerServices(join(directory, 'data'), runnerId, { projects: [{ id: 'project', name: 'Project', path: projectPath }], providers: [] });
  const app = await createRunnerApplication({ runnerId, name: 'Test', protocolVersion: 1, capabilities: { taskExecution: true, eventReplay: true } }, header => header === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const route = '/v1/projects/project/repository-identity';
  const request = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: { authorization: 'Bearer test', ...headers } });
  assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await request(route)).status, 409);
  assert.equal((await request(route, { 'x-codevo-runner-id': randomUUID() })).status, 409);
  const headers = { 'x-codevo-runner-id': runnerId };
  assert.deepEqual(await (await request(route, headers)).json(), { repositoryKey: 'github.com/owner/repo' });
  assert.equal((await request('/v1/projects/unknown/repository-identity', headers)).status, 404);
  assert.equal((await request(route + '?extra=1', headers)).status, 404);
  assert.deepEqual(await (await request('/v1/projects', headers)).json(), { items: [{ id: 'project', name: 'Project' }] });
});
