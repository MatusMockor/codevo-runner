import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCloneProviderAuth } from '../src/infrastructure/projects/clone-provider-auth.js';
import type { RepositoryLookupPort } from '../src/application/repository-lookup-service.js';
import type { RepositoryHostsState } from '../src/domain/repository-lookup.js';

const signal = () => new AbortController().signal;
const ready = (host: string, provider: 'github' | 'gitlab' = 'gitlab'): RepositoryHostsState => ({
  status: 'ready', hosts: [{ provider, host, auth: 'authenticated' }], truncated: false,
});
const lookup = (state: RepositoryHostsState): Pick<RepositoryLookupPort, 'hosts'> => ({ hosts: async () => state });

test('authenticated HTTPS clones use only fixed host-scoped provider helpers, without tokens', async () => {
  assert.deepEqual(await prepareCloneProviderAuth('https://github.com/team/private.git', signal(), lookup(ready('github.com', 'github'))), [
    '-c', 'http.followRedirects=false', '-c', 'credential.https://github.com.helper=!gh auth git-credential',
  ]);
  assert.deepEqual(await prepareCloneProviderAuth('https://git.company.test/team/private.git', signal(), lookup(ready('git.company.test'))), [
    '-c', 'http.followRedirects=false', '-c', 'credential.https://git.company.test.helper=!glab auth git-credential',
  ]);
});

test('malformed, credential-bearing, SSH and ambiguous HTTPS authorities never request CLI auth', async () => {
  const noLookup: Pick<RepositoryLookupPort, 'hosts'> = { hosts: async () => { assert.fail('must not query provider'); } };
  for (const url of [
    'git@github.com:team/repo.git', 'ssh://git@github.com/team/repo', 'http://github.com/team/repo',
    'https://user:secret@github.com/team/repo', 'https://user@github.com/team/repo',
    'https://github.com:8443/team/repo', 'https://github.com/team/repo?token=secret',
    'https://github.com/team/repo#secret', 'https://github.com\\@evil.test/team/repo',
    'https://github.com/team/repo\n', 'https://github.com/team/white space', 'not a url',
  ]) assert.deepEqual(await prepareCloneProviderAuth(url, signal(), noLookup), []);
});

test('authentication is required for the exact provider and host, without suffix matching', async () => {
  for (const state of [
    { status: 'cliMissing' }, { status: 'failed', reason: 'timedOut' },
    { status: 'ready', hosts: [{ provider: 'gitlab', host: 'git.company.test', auth: 'notAuthenticated' }], truncated: false },
    ready('company.test'), ready('git.company.test.evil.test'), ready('git.company.test', 'github'),
  ] satisfies RepositoryHostsState[]) {
    assert.deepEqual(await prepareCloneProviderAuth('https://git.company.test/team/repo.git', signal(), lookup(state)), []);
  }
  assert.deepEqual(await prepareCloneProviderAuth('https://github.com.evil.test/team/repo.git', signal(), lookup(ready('github.com', 'github'))), []);
});

test('cancelled lookup cannot publish a credential plan after the await', async () => {
  const controller = new AbortController();
  await assert.rejects(prepareCloneProviderAuth('https://github.com/team/repo.git', controller.signal, {
    hosts: async () => { controller.abort(); return ready('github.com', 'github'); },
  }), { name: 'AbortError' });
  await assert.rejects(prepareCloneProviderAuth('https://github.com/team/repo.git', controller.signal, lookup(ready('github.com', 'github'))), { name: 'AbortError' });
});

test('Git invokes the fixed helper only for its configured HTTPS host', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'codevo-clone-auth-'));
  try {
    const capture = join(directory, 'invocation');
    await writeFile(join(directory, 'gh'), '#!/bin/sh\n[ "$*" = "auth git-credential get" ] || exit 1\ncat > "$CODEVO_TEST_CAPTURE"\nprintf "username=test-user\\npassword=fixture-only\\n"\n', { mode: 0o700 });
    const plan = await prepareCloneProviderAuth('https://github.com/team/repo.git', signal(), lookup(ready('github.com', 'github')));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { PATH: `${directory}:${process.env.PATH}`, CODEVO_TEST_CAPTURE: capture,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' });
    const run = (host: string) => spawnSync('git', ['-c', 'credential.helper=', ...plan, 'credential', 'fill'], {
      cwd: directory, env, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    });
    const accepted = run('github.com');
    assert.equal(accepted.status, 0);
    assert.equal(accepted.stdout.includes('password=fixture-only'), true);
    assert.equal((await readFile(capture, 'utf8')).includes('host=github.com'), true);
    await rm(capture);
    for (const host of ['github.com.evil.test', 'evil.test', 'github.com:8443']) {
      const rejected = run(host);
      assert.notEqual(rejected.status, 0);
      assert.equal(rejected.stdout.includes('fixture-only'), false);
      await assert.rejects(readFile(capture), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
