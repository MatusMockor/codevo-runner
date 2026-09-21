import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryRequest } from '../src/domain/repository-lookup.js';
import { RepositoryLookupService } from '../src/application/repository-lookup-service.js';
import { CliRepositoryLookup, type RepositoryCli } from '../src/infrastructure/projects/repository-lookup.js';
const request = { provider: 'github', host: 'github.com', query: 'crm', page: 1 };
const result = { full_name: 'team/crm', description: 'CRM', private: true, default_branch: 'main', clone_url: 'https://secret@evil.example/x' };
function fixture(api: unknown) {
  const calls: readonly string[][] = [];
  const mutable = calls as string[][];
  const run: RepositoryCli = async (_program, args) => { mutable.push([...args]); return { code: 0, stdout: args[0] === 'auth' ? '' : JSON.stringify(api), stderr: '' }; };
  return { service: new RepositoryLookupService(new CliRepositoryLookup(run)), calls };
}
test('closed search input rejects injection, whitespace, bounds and extras before CLI', () => {
  for (const patch of [{ query: 'a;id' }, { query: '--help' }, { query: ' crm' }, { query: 'a..b' }, { page: 0 }, { page: 11 }, { command: 'id' }, { host: 'https://example.com' }]) {
    assert.throws(() => parseRepositoryRequest({ ...request, ...patch }, true));
  }
});
test('server search validates server auth authority and strips external credentials', async () => {
  const { service, calls } = fixture({ items: [result], total_count: 21, incomplete_results: false });
  const found = await service.search(request);
  assert.equal(found.status, 'ok');
  if (found.status !== 'ok') return;
  assert.equal(found.nextPage, 2);
  assert.equal(found.repositories[0]?.httpsUrl, 'https://github.com/team/crm.git');
  assert.equal(found.repositories[0]?.visibility, 'private');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.[3], 'search/repositories?q=crm%20in%3Aname%20fork%3Atrue&per_page=20&page=1');
});
test('unconfigured hosts never cause a network request', async () => {
  const { service, calls } = fixture(result);
  assert.deepEqual(await service.lookup({ provider: 'github', host: 'evil.example', path: 'a/b' }), { status: 'hostNotAllowed' });
  assert.equal(calls.length, 1);
});
test('last page exposes truncation; malformed provider output fails closed', async () => {
  assert.deepEqual(await fixture({ items: [result], total_count: 201, incomplete_results: false }).service.search({ ...request, page: 10 }), { status: 'ok', repositories: [{ provider: 'github', host: 'github.com', fullPath: 'team/crm', description: 'CRM', visibility: 'private', defaultBranch: 'main', sshUrl: 'git@github.com:team/crm.git', httpsUrl: 'https://github.com/team/crm.git' }], nextPage: null, truncated: true });
  assert.deepEqual(await fixture({ items: [{ full_name: '../secret' }], total_count: 1, incomplete_results: false }).service.search(request), { status: 'failed', reason: 'invalidOutput' });
});
test('cancellation after auth prevents query publication/execution', async () => {
  const abort = new AbortController();
  let calls = 0;
  const service = new RepositoryLookupService(new CliRepositoryLookup(async () => { calls++; abort.abort(); return { code: 0, stdout: '', stderr: '' }; }));
  await assert.rejects(service.search(request, abort.signal));
  assert.equal(calls, 1);
});
test('admission is bounded without a queue', async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const service = new RepositoryLookupService(new CliRepositoryLookup(async () => { await gate; return { code: 1, stdout: '', stderr: '' }; }));
  const first = service.search(request), second = service.search(request);
  assert.deepEqual(await service.search(request), { status: 'failed', reason: 'busy' });
  resolve(); await Promise.all([first, second]);
});
test('GitLab lookup uses only server authenticated hosts and encoded namespace', async () => {
  const calls: string[][] = [];
  const adapter = new CliRepositoryLookup(async (_program, args) => {
    calls.push([...args]);
    return { code: 0, stdout: args[0] === 'auth' ? '' : JSON.stringify({ path_with_namespace: 'team/sub/crm', visibility: 'internal' }), stderr: args[0] === 'auth' ? 'git.example\n  ✓ Logged in to git.example as person\n' : '' };
  });
  const service = new RepositoryLookupService(adapter);
  assert.equal((await service.lookup({ provider: 'gitlab', host: 'git.example', path: 'team/sub/crm' })).status, 'ok');
  assert.equal(calls[1]?.[3], 'projects/team%2Fsub%2Fcrm');
});
test('missing CLI, timeout, output quota, rate limit and malformed JSON remain safe closed outcomes', async () => {
  for (const [response, expected] of [
    [{ code: null, stdout: '', stderr: '', failure: 'cliMissing' as const }, { status: 'cliMissing' }],
    [{ code: null, stdout: '', stderr: '', failure: 'timedOut' as const }, { status: 'timedOut' }],
    [{ code: null, stdout: '', stderr: '', failure: 'outputTooLarge' as const }, { status: 'failed', reason: 'outputTooLarge' }],
    [{ code: 1, stdout: '', stderr: 'HTTP 429 secret-token' }, { status: 'rateLimited', retryAfterSeconds: null }],
    [{ code: 0, stdout: 'secret-token', stderr: '' }, { status: 'failed', reason: 'invalidOutput' }],
  ] as const) {
    const adapter = new CliRepositoryLookup(async () => response);
    assert.deepEqual(await adapter.search({ provider: 'github', host: 'github.com', query: 'crm', page: 1 }, new AbortController().signal), expected);
  }
});
test('GitLab unauthenticated hosts cannot execute lookup and host list is bounded', async () => {
  let calls = 0;
  const adapter = new CliRepositoryLookup(async () => {
    calls++;
    return { code: 1, stdout: '', stderr: Array.from({ length: 10 }, (_, index) => `git${index}.example\n  ✗ Not logged in`).join('\n') };
  });
  const state = await adapter.hosts('gitlab', new AbortController().signal);
  assert.equal(state.status, 'ready');
  if (state.status === 'ready') { assert.equal(state.hosts.length, 8); assert.equal(state.truncated, true); }
  const service = new RepositoryLookupService(adapter);
  assert.deepEqual(await service.lookup({ provider: 'gitlab', host: 'git0.example', path: 'team/crm' }), { status: 'notAuthenticated' });
  assert.equal(calls, 2);
});

test('provider control characters and invalid branches cannot break the editor response parser', async () => {
  const found = await fixture({ ...result, description: 'hello\u0085\u009bworld', default_branch: 'a b' }).service.lookup({ provider: 'github', host: 'github.com', path: 'team/crm' });
  assert.equal(found.status, 'ok');
  if (found.status === 'ok') { assert.equal(found.repository.description, 'helloworld'); assert.equal(found.repository.defaultBranch, null); }
});
