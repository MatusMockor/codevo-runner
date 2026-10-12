import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { MCP_SERVER_LOGIN_ID_PATTERN } from '../src/domain/mcp-server-management.js';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import {
  CLAUDE_AUTH_URL, CLAUDE_CALLBACK_URL, SECRET, callbackListener, claudeAwaiting, claudeBrowser, claudeManagementScript, claudeNothing, claudeStatus, codexAuthUrl,
  codexCompleted, codexLoginResult, codexManagementScript, eventually, heldListener, stdinRequests,
} from './mcp-server-management-fixture.js';
import { assertTreeReaped, lines, readPid, shellFixture, writeJson } from './mcp-servers-fixture.js';

const exec = promisify(execFile);
type Reply = Readonly<{ status: number; body: unknown; text: string; cache: string | null }>;
const descriptor = (runnerId: string) => ({ protocolVersion: 1 as const, runnerId, name: 'Management', capabilities: { taskExecution: false, eventReplay: true } });
const http = { kind: 'http', url: 'https://mcp.example.com/mcp' };
const addition = (name = 'docs', changed: Readonly<Record<string, unknown>> = {}) => ({ change: { kind: 'add', name, scope: 'user', launch: http, ...changed } });
const removal = (name = 'docs', scope = 'user') => ({ change: { kind: 'remove', name, scope } });
const signIn = (name = 'docs', mode = 'signIn') => ({ name, mode });
const unknownLogin = '0b9f3c1e-7d2a-4f65-9c11-2d8f4a6b7c90';

async function runner(t: TestContext, configure: (root: string) => Promise<Partial<RunnerExecutionOptions>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-management-api-')));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [], ...await configure(root) });
  const app = await createRunnerApplication(descriptor(runnerId), header => header === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  const call = async (method: string, path: string, value?: unknown, extra: Readonly<Record<string, string>> = {}): Promise<Reply> => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, cache: response.headers.get('cache-control') };
  };
  return { root, claude: join(root, 'claude-fake'), codex: join(root, 'codex-fake'), project: join(root, 'project'), runnerId, services, app, base, headers, call };
}
async function managementRunner(t: TestContext, cli: Readonly<{ loginDeadlineMs?: number; callbackTimeoutMs?: number }> = {}) {
  return runner(t, async root => {
    const project = join(root, 'project'), second = join(root, 'second'), plain = join(root, 'plain'), claude = join(root, 'claude-fake'), codex = join(root, 'codex-fake');
    for (const directory of [project, second, plain, claude, codex, join(claude, 'configured'), join(codex, 'configured')]) await mkdir(directory);
    await exec('git', ['init', '-q', project]);
    await exec('git', ['init', '-q', second]);
    await writeJson(codex, 'config.json', { result: { config: { mcp_servers: { taken: { url: 'https://taken.example.com/mcp' } } } } });
    await writeJson(codex, 'write.json', { result: { status: 'ok' } });
    await writeJson(claude, 'authenticate.json', claudeAwaiting);
    await writeJson(claude, 'status.json', claudeStatus('docs', 'needs-auth'));
    return { projects: [{ id: 'example', name: 'Example', path: project }, { id: 'second', name: 'Second', path: second }, { id: 'plain', name: 'Plain', path: plain }],
      mcpServerManagementCli: { claudeExecutable: await shellFixture(claude, 'claude', claudeManagementScript(claude)),
        codexExecutable: await shellFixture(codex, 'codex', codexManagementScript(codex)), timing: { retryMs: 10, locateMs: 150, pollMs: 30, startMs: 4_000 },
        callbackTimeoutMs: 2_000, ...cli } };
  });
}
function withBody(url: string, method: string, headers: Readonly<Record<string, string>>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method, headers: { ...headers, 'content-length': '2' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end('{}');
  });
}
const launches = async (state: Readonly<{ claude: string; codex: string }>) => [(await lines(state.claude, 'launches')).length, (await lines(state.codex, 'launches')).length];
function loginIdOf(reply: Reply): string {
  assert.equal(reply.status, 200, reply.text);
  const step = (reply.body as { step: { kind: string; loginId: string } }).step;
  assert.equal(step.kind, 'awaitingCallback');
  assert.match(step.loginId, MCP_SERVER_LOGIN_ID_PATTERN);
  return step.loginId;
}

test('mcpServerManagement is announced only to clients that understand it and only with a management configuration', async t => {
  const { base, headers } = await managementRunner(t);
  const legacy = (await (await fetch(`${base}/v1/runner`, { headers })).json()).capabilities;
  assert.equal('mcpServerManagement' in legacy, false);
  assert.deepEqual((await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'mcpServers' } })).json()).capabilities, { ...legacy, mcpServers: false });
  const modern = (await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'mcpServers,mcpServerManagement' } })).json()).capabilities;
  assert.deepEqual(modern, { ...legacy, mcpServers: false, mcpServerManagement: true });

  const injected = await runner(t, async () => ({}));
  const silent = (await (await fetch(`${injected.base}/v1/runner`, { headers: { ...injected.headers, 'x-codevo-client-capabilities': 'mcpServerManagement' } })).json()).capabilities;
  assert.equal(silent.mcpServerManagement, false);
  for (const [method, path, body] of [['POST', '/changes', addition()], ['POST', '/logins', signIn()], ['GET', `/logins/${unknownLogin}`, undefined],
    ['POST', `/logins/${unknownLogin}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL }], ['DELETE', `/logins/${unknownLogin}`, undefined]] as const) {
    const disabled = await injected.call(method, `/v1/projects/example/mcp-servers/claude${path}`, body);
    assert.deepEqual([disabled.status, disabled.body], [404, { error: 'not_found' }], `${method} ${path}`);
  }

  const discovery = await createRunnerApplication({ ...descriptor(randomUUID()), capabilities: { taskExecution: false, eventReplay: true, mcpServerManagement: true } }, () => true);
  t.after(() => discovery.close());
  await discovery.listen(0, '127.0.0.1');
  const address = `http://127.0.0.1:${(discovery.getHttpServer().address() as AddressInfo).port}`;
  const only = await (await fetch(`${address}/v1/runner`, { headers: { 'x-codevo-client-capabilities': 'mcpServerManagement' } })).json();
  assert.equal(only.capabilities.mcpServerManagement, false);
  assert.equal((await fetch(`${address}/v1/projects/example/mcp-servers/claude/logins/${unknownLogin}`)).status, 404);
});

test('management routes enforce auth, owner identity, exact methods, bodies and paths before any provider starts', async t => {
  const state = await managementRunner(t);
  const { base, headers } = state;
  const routes: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['POST', '/changes', ['GET', 'PUT', 'PATCH', 'DELETE']], ['POST', '/logins', ['GET', 'PUT', 'PATCH', 'DELETE']],
    ['GET', `/logins/${unknownLogin}`, ['POST', 'PUT', 'PATCH']], ['DELETE', `/logins/${unknownLogin}`, ['POST', 'PUT', 'PATCH']],
    ['POST', `/logins/${unknownLogin}/callback`, ['GET', 'PUT', 'PATCH', 'DELETE']],
  ];
  for (const provider of ['claude', 'codex']) {
    for (const [method, path, refused] of routes) {
      const url = `${base}/v1/projects/example/mcp-servers/${provider}${path}`;
      assert.equal((await fetch(url, { method })).status, 401, url);
      assert.equal((await fetch(url, { method, headers: { authorization: 'Bearer wrong', 'x-codevo-runner-id': headers['x-codevo-runner-id'] } })).status, 401, url);
      const anonymous = await fetch(url, { method, headers: { authorization: 'Bearer test' } });
      assert.deepEqual([anonymous.status, await anonymous.json()], [409, { error: 'runner_identity_mismatch' }], url);
      assert.equal((await fetch(url, { method, headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409, url);
      assert.equal((await fetch(url, { method, headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403, url);
      assert.equal((await fetch(`${url}?cwd=/tmp`, { method, headers })).status, 404, url);
      assert.equal((await fetch(`${url}/`, { method, headers })).status, 404, url);
      for (const other of refused) {
        const reply = await fetch(url, { method: other, headers });
        assert.deepEqual([reply.status, await reply.json()], [405, { error: 'method_not_allowed' }], `${other} ${url}`);
      }
    }
    for (const method of ['GET', 'DELETE']) assert.equal(await withBody(`${base}/v1/projects/example/mcp-servers/${provider}/logins/${unknownLogin}`, method, headers), 400, method);
  }
  for (const [method, path] of [['POST', '/v1/projects/example/mcp-servers/other/changes'], ['POST', '/v1/projects/example/mcp-servers/claudeCode/logins'],
    ['POST', '/v1/projects/-bad/mcp-servers/claude/changes'], ['POST', `/v1/projects/${'a'.repeat(65)}/mcp-servers/codex/logins`],
    ['GET', '/v1/projects/example/mcp-servers/claude/changes/1'], ['GET', '/v1/projects/example/mcp-servers/claude/logins/short'], ['GET', `/v1/projects/example/mcp-servers/claude/logins/${'a'.repeat(65)}`],
    ['GET', '/v1/projects/example/mcp-servers/claude/logins/has_underscore'], ['GET', '/v1/projects/example/mcp-servers/claude/logins/..%2F..%2Fetc'],
    ['DELETE', '/v1/projects/example/mcp-servers/claude/logins/short'], ['POST', '/v1/projects/example/mcp-servers/claude/logins/short/callback'],
    ['POST', `/v1/projects/example/mcp-servers/claude/logins/${unknownLogin}/callback/again`], ['POST', `/v1/projects/example/mcp-servers/claude/logins/${unknownLogin}/cancel`]] as const) {
    const reply = await state.call(method, path);
    assert.deepEqual([reply.status, reply.body], [404, { error: 'not_found' }], `${method} ${path}`);
  }
  for (const [path, body] of [['/v1/projects/missing/mcp-servers/claude/changes', addition()], ['/v1/projects/missing/mcp-servers/codex/logins', signIn()],
    [`/v1/projects/missing/mcp-servers/codex/logins/${unknownLogin}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL }]] as const) {
    const reply = await state.call('POST', path, body);
    assert.deepEqual([reply.status, reply.body], [404, { error: 'not_found' }], path);
  }
  for (const method of ['GET', 'DELETE']) assert.equal((await state.call(method, `/v1/projects/missing/mcp-servers/claude/logins/${unknownLogin}`)).status, 404, method);
  assert.deepEqual(await launches(state), [0, 0]);
});

test('management bodies are strict bounded JSON and every limit is enforced before any provider starts', async t => {
  const state = await managementRunner(t);
  const changes = '/v1/projects/example/mcp-servers/claude/changes', logins = '/v1/projects/example/mcp-servers/claude/logins';
  const callback = `${logins}/${unknownLogin}/callback`;
  for (const path of [changes, logins, callback]) {
    const untyped = await state.call('POST', path, undefined, { 'content-type': 'text/plain' });
    assert.deepEqual([untyped.status, untyped.body], [415, { error: 'unsupported_media' }], path);
    const absent = await state.call('POST', path);
    assert.deepEqual([absent.status, absent.body], [415, { error: 'unsupported_media' }], path);
    const encoded = await state.call('POST', path, '{}', { 'content-encoding': 'gzip' });
    assert.deepEqual([encoded.status, encoded.body], [415, { error: 'unsupported_media' }], path);
    for (const text of ['{', '[]', 'null', '"text"', '{}']) {
      const reply = await state.call('POST', path, text);
      assert.deepEqual([reply.status, reply.body], [400, { error: 'invalid_input' }], `${path} ${text}`);
    }
  }
  const oversized: ReadonlyArray<readonly [string, unknown]> = [
    [changes, addition('docs', { launch: { kind: 'stdio', command: 'npx', args: ['x'.repeat(96 * 1024)] } })],
    [logins, { name: 'docs', mode: 'signIn', padding: 'x'.repeat(1024) }],
    [callback, { callbackUrl: `http://localhost:1/callback?code=${'a'.repeat(16 * 1024)}` }],
  ];
  for (const [path, body] of oversized) {
    const reply = await state.call('POST', path, body);
    assert.deepEqual([reply.status, reply.body], [413, { error: 'too_large' }], path);
  }
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    [changes, { ...addition(), cwd: '/tmp' }], [changes, addition('-docs')], [changes, addition('a'.repeat(65))], [changes, addition('docs', { scope: 'managed' })],
    [changes, addition('docs', { env: { TOKEN: SECRET } })], [changes, addition('docs', { launch: { ...http, headers: { Authorization: SECRET } } })],
    [changes, addition('docs', { launch: { kind: 'http', url: `https://user:${SECRET}@mcp.example.com/mcp` } })], [changes, addition('docs', { launch: { kind: 'http', url: 'file:///etc/passwd' } })],
    [changes, addition('docs', { launch: { kind: 'http', url: `https://mcp.example.com/${'a'.repeat(2048)}` } })], [changes, addition('docs', { launch: { kind: 'stdio', command: '', args: [] } })],
    [changes, addition('docs', { launch: { kind: 'stdio', command: 'a'.repeat(1025), args: [] } })], [changes, addition('docs', { launch: { kind: 'stdio', command: 'npx', args: Array.from({ length: 33 }, () => 'a') } })],
    [changes, addition('docs', { launch: { kind: 'stdio', command: 'npx', args: ['a'.repeat(1025)] } })], [changes, addition('docs', { launch: { kind: 'stdio', command: 'npx', args: ['a\u0000b'] } })],
    [changes, addition('docs', { launch: { kind: 'stdio', command: 'sh -c', args: 'echo' } })], [changes, { change: { kind: 'remove', name: 'docs' } }], [changes, { change: { kind: 'signOut', name: ' docs' } }],
    [changes, { change: { kind: 'signOut', name: 'a'.repeat(129) } }], [changes, { change: { kind: 'rename', name: 'docs', to: 'other' } }],
    [logins, { name: 'docs' }], [logins, { name: 'docs', mode: 'signOut' }], [logins, { name: '', mode: 'signIn' }], [logins, { ...signIn(), scope: 'user' }], [logins, { ...signIn(), callbackUrl: CLAUDE_CALLBACK_URL }],
    [callback, { callbackUrl: 'https://localhost:45678/callback?code=1' }], [callback, { callbackUrl: 'http://example.com/callback?code=1' }], [callback, { callbackUrl: 'http://localhost:45678/callback' }],
    [callback, { callbackUrl: `http://localhost:45678/callback?code=${'a'.repeat(8192)}` }], [callback, { callbackUrl: CLAUDE_CALLBACK_URL, loginId: unknownLogin }], [callback, { url: CLAUDE_CALLBACK_URL }],
  ];
  for (const [path, body] of invalid) {
    const reply = await state.call('POST', path, body);
    assert.deepEqual([reply.status, reply.body], [400, { error: 'invalid_input' }], `${path} ${JSON.stringify(body).slice(0, 120)}`);
  }
  const unsupported: ReadonlyArray<readonly [string, unknown]> = [
    ['claude', addition('docs', { scope: 'project' })], ['codex', addition('docs', { scope: 'local' })], ['codex', addition('docs', { scope: 'project' })],
    ['codex', addition('docs', { launch: { kind: 'sse', url: 'https://mcp.example.com/sse' } })], ['codex', removal('docs', 'local')], ['codex', removal('docs', 'project')],
  ];
  for (const [provider, body] of unsupported) {
    const reply = await state.call('POST', `/v1/projects/example/mcp-servers/${provider}/changes`, body);
    assert.deepEqual([reply.status, reply.body], [409, { error: 'mcp_change_unsupported' }], `${provider} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await launches(state), [0, 0]);
});

test('changes add, remove and sign out through the provider in the project checkout with distinguishable outcomes', async t => {
  const state = await managementRunner(t);
  const claude = '/v1/projects/example/mcp-servers/claude/changes', codex = '/v1/projects/example/mcp-servers/codex/changes';
  const added = await state.call('POST', claude, addition('docs', { scope: 'local', launch: { kind: 'stdio', command: '--scope', args: ['-e', 'EVIL=1', '--', '$(touch pwned)'] } }));
  assert.deepEqual([added.status, added.body, added.cache], [200, { version: 1 }, 'no-store']);
  assert.deepEqual(await lines(state.claude, 'args-1'), ['mcp', 'add', '--scope', 'local', '--transport', 'stdio', '--', 'docs', '--scope', '-e', 'EVIL=1', '--', '$(touch pwned)']);
  assert.deepEqual([await lines(state.claude, 'cwd'), await lines(state.project, 'pwned')], [[state.project], []]);
  const existing = await state.call('POST', claude, addition('docs', { scope: 'local' }));
  assert.deepEqual([existing.status, existing.text], [409, '{"error":"mcp_server_exists"}']);
  assert.deepEqual((await state.call('POST', claude, removal('docs', 'local'))).body, { version: 1 });
  const missing = await state.call('POST', claude, removal('docs', 'project'));
  assert.deepEqual([missing.status, missing.text], [409, '{"error":"mcp_server_not_found"}']);
  assert.deepEqual((await state.call('POST', claude, { change: { kind: 'signOut', name: 'claude.ai Gmail' } })).body, { version: 1 });
  await writeFile(join(state.claude, 'clear-auth-error'), 'Cannot clear auth for this server type');
  const refused = await state.call('POST', claude, { change: { kind: 'signOut', name: 'docs' } });
  assert.deepEqual([refused.status, refused.text], [409, '{"error":"mcp_change_unsupported"}']);
  await assertTreeReaped(state.claude);

  assert.deepEqual((await state.call('POST', codex, addition('fresh'))).body, { version: 1 });
  assert.equal((await lines(state.codex, 'stdin')).at(-1), JSON.stringify({ id: 2, method: 'config/batchWrite',
    params: { edits: [{ keyPath: 'mcp_servers.fresh', mergeStrategy: 'replace', value: { url: http.url } }] } }));
  const taken = await state.call('POST', codex, addition('taken'));
  assert.deepEqual([taken.status, taken.text], [409, '{"error":"mcp_server_exists"}']);
  const absent = await state.call('POST', codex, removal('absent'));
  assert.deepEqual([absent.status, absent.text], [409, '{"error":"mcp_server_not_found"}']);
  assert.deepEqual((await state.call('POST', codex, { change: { kind: 'signOut', name: 'fresh' } })).body, { version: 1 });
  await writeFile(join(state.codex, 'cli-fail'), `keyring ${SECRET}\n`);
  const failed = await state.call('POST', codex, removal('fresh'));
  assert.deepEqual([failed.status, failed.text], [503, '{"error":"storage_unavailable"}']);
  await assertTreeReaped(state.codex);

  const before = await launches(state);
  for (const path of ['/v1/projects/plain/mcp-servers/claude/changes', '/v1/projects/plain/mcp-servers/codex/changes']) {
    const reply = await state.call('POST', path, addition('other'));
    assert.deepEqual([reply.status, reply.text], [503, '{"error":"storage_unavailable"}'], path);
  }
  assert.deepEqual(await launches(state), before);
});

test('a Claude login is started, polled, completed by a pasted callback and forgotten after a cancel', async t => {
  const state = await managementRunner(t);
  const base = '/v1/projects/example/mcp-servers/claude/logins';
  const started = await state.call('POST', base, signIn());
  const loginId = loginIdOf(started);
  assert.deepEqual([started.body, started.cache], [{ version: 1, step: { kind: 'awaitingCallback', loginId, authorizationUrl: CLAUDE_AUTH_URL, delivery: 'paste' } }, 'no-store']);
  assert.equal(state.services.mcpServerManagement!.working, true);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'pending' });
  for (const path of [`/v1/projects/second/mcp-servers/claude/logins/${loginId}`, `/v1/projects/example/mcp-servers/codex/logins/${loginId}`, `${base}/${unknownLogin}`]) {
    const reply = await state.call('GET', path);
    assert.deepEqual([reply.status, reply.text], [409, '{"error":"mcp_login_inactive"}'], path);
  }
  const foreign = await state.call('POST', `/v1/projects/second/mcp-servers/claude/logins/${loginId}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL });
  assert.deepEqual([foreign.status, foreign.text], [409, '{"error":"mcp_login_inactive"}']);
  const stolen = await state.call('DELETE', `/v1/projects/second/mcp-servers/claude/logins/${loginId}`);
  assert.deepEqual([stolen.status, stolen.text], [409, '{"error":"mcp_login_inactive"}']);
  assert.deepEqual((await state.call('DELETE', `${base}/${unknownLogin}`)).body, { version: 1 });

  await writeFile(join(state.claude, 'callback-error'), 'Callback URL not accepted: it belongs to a different sign-in attempt');
  const rejected = await state.call('POST', `${base}/${loginId}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL });
  assert.deepEqual([rejected.status, rejected.text], [409, '{"error":"mcp_callback_rejected"}']);
  await rm(join(state.claude, 'callback-error'));
  const accepted = await state.call('POST', `${base}/${loginId}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL });
  assert.deepEqual([accepted.status, accepted.body], [200, { version: 1 }]);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'pending' });
  await writeJson(state.claude, 'status.json', claudeStatus('docs', 'connected'));
  await eventually(() => state.call('GET', `${base}/${loginId}`), reply => (reply.body as { state: string }).state === 'succeeded', 'success');
  await eventually(() => state.services.mcpServerManagement!.working, working => !working, 'settlement');
  await assertTreeReaped(state.claude);
  const late = await state.call('POST', `${base}/${loginId}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL });
  assert.deepEqual([late.status, late.text], [409, '{"error":"mcp_login_inactive"}']);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'succeeded' });
  assert.deepEqual((await state.call('DELETE', `${base}/${loginId}`)).body, { version: 1 });
  const forgotten = await state.call('GET', `${base}/${loginId}`);
  assert.deepEqual([forgotten.status, forgotten.text], [409, '{"error":"mcp_login_inactive"}']);
  assert.deepEqual((await state.call('DELETE', `${base}/${loginId}`)).body, { version: 1 });
  assert.deepEqual((await stdinRequests(state.claude)).filter(request => JSON.stringify(request).includes('mcp_oauth_callback_url')).map(request => (request.request as { callbackUrl: string }).callbackUrl),
    [CLAUDE_CALLBACK_URL, CLAUDE_CALLBACK_URL]);
});

test('Claude logins without a callback and refused logins answer at once and keep no session', async t => {
  const state = await managementRunner(t);
  const base = '/v1/projects/example/mcp-servers/claude/logins';
  await writeJson(state.claude, 'authenticate.json', claudeNothing);
  assert.deepEqual((await state.call('POST', base, signIn('docs', 'signInAgain'))).body, { version: 1, step: { kind: 'completed' } });
  assert.equal((await stdinRequests(state.claude)).some(request => JSON.stringify(request).includes('mcp_clear_auth')), true);
  await writeJson(state.claude, 'authenticate.json', claudeBrowser);
  assert.deepEqual((await state.call('POST', base, signIn('claude.ai Gmail'))).body, { version: 1, step: { kind: 'finishInBrowser', authorizationUrl: claudeBrowser.authUrl } });
  await writeFile(join(state.claude, 'authenticate-error'), 'Server type stdio does not support OAuth authentication');
  const unsupported = await state.call('POST', base, signIn());
  assert.deepEqual([unsupported.status, unsupported.text], [409, '{"error":"mcp_login_unsupported"}']);
  await writeFile(join(state.claude, 'authenticate-error'), 'Server not found: docs');
  const missing = await state.call('POST', base, signIn());
  assert.deepEqual([missing.status, missing.text], [409, '{"error":"mcp_server_not_found"}']);
  await rm(join(state.claude, 'authenticate-error'));
  await writeJson(state.claude, 'authenticate.json', { authUrl: `http://evil.example.com/${SECRET}`, requiresUserAction: true, callbackExpected: true });
  const unusable = await state.call('POST', base, signIn());
  assert.deepEqual([unusable.status, unusable.text], [503, '{"error":"storage_unavailable"}']);
  const plain = await state.call('POST', '/v1/projects/plain/mcp-servers/claude/logins', signIn());
  assert.deepEqual([plain.status, plain.text], [503, '{"error":"storage_unavailable"}']);
  assert.equal(state.services.mcpServerManagement!.working, false);
  await assertTreeReaped(state.claude);
});

test('a Codex login forwards a pasted callback once to its own loopback redirect and reports the completion', async t => {
  const state = await managementRunner(t);
  const listener = await callbackListener(t, 200, () => { void writeJson(state.codex, 'completed.json', codexCompleted('docs', true)); });
  await writeJson(state.codex, 'login.json', codexLoginResult(listener.port));
  const base = '/v1/projects/example/mcp-servers/codex/logins';
  const started = await state.call('POST', base, signIn('docs', 'signInAgain'));
  const loginId = loginIdOf(started);
  assert.deepEqual(started.body, { version: 1, step: { kind: 'awaitingCallback', loginId, authorizationUrl: codexAuthUrl(listener.port), delivery: 'paste' } });
  assert.deepEqual([await lines(state.codex, 'args-1'), await lines(state.codex, 'args-2')], [['mcp', 'logout', '--', 'docs'], ['app-server', '--stdio']]);
  for (const callbackUrl of [`http://127.0.0.1:${listener.port + 1}/callback?code=1`, `http://127.0.0.1:${listener.port}/elsewhere?code=1`, `http://localhost/callback?code=1`]) {
    const reply = await state.call('POST', `${base}/${loginId}/callback`, { callbackUrl });
    assert.deepEqual([reply.status, reply.text], [409, '{"error":"mcp_callback_rejected"}'], callbackUrl);
  }
  assert.deepEqual(listener.requests, []);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'pending' });
  const accepted = await state.call('POST', `${base}/${loginId}/callback`, { callbackUrl: `http://localhost:${listener.port}/callback?code=${SECRET}&state=s%20t` });
  assert.deepEqual([accepted.status, accepted.body], [200, { version: 1 }]);
  assert.deepEqual(listener.requests, [`GET /callback?code=${SECRET}&state=s%20t 127.0.0.1:${listener.port}`]);
  await eventually(() => state.call('GET', `${base}/${loginId}`), reply => (reply.body as { state: string }).state === 'succeeded', 'success');
  await eventually(() => state.services.mcpServerManagement!.working, working => !working, 'settlement');
  await assertTreeReaped(state.codex);
  assert.equal(listener.requests.length, 1);

  await writeJson(state.codex, 'login.json', { error: { code: -32600, message: "No MCP server named 'docs' found." } });
  const missing = await state.call('POST', base, signIn());
  assert.deepEqual([missing.status, missing.text], [409, '{"error":"mcp_server_not_found"}']);
  await writeJson(state.codex, 'login.json', { error: { code: -32600, message: 'OAuth login is only supported for streamable HTTP servers.' } });
  const unsupported = await state.call('POST', base, signIn());
  assert.deepEqual([unsupported.status, unsupported.text], [409, '{"error":"mcp_login_unsupported"}']);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'succeeded' });
});

test('a new login replaces the previous one, a cancel reaps the provider and the deadline fails a login', async t => {
  const state = await managementRunner(t);
  const claude = '/v1/projects/example/mcp-servers/claude/logins', codex = '/v1/projects/second/mcp-servers/codex/logins';
  await writeJson(state.codex, 'login.json', codexLoginResult(45_679));
  const first = loginIdOf(await state.call('POST', claude, signIn()));
  const firstPid = await readPid(state.claude);
  const second = loginIdOf(await state.call('POST', codex, signIn()));
  assert.notEqual(second, first);
  await assertTreeReaped(state.claude);
  assert.deepEqual((await state.call('GET', `${claude}/${first}`)).body, { version: 1, state: 'failed' });
  assert.deepEqual((await state.call('GET', `${codex}/${second}`)).body, { version: 1, state: 'pending' });
  const late = await state.call('POST', `${claude}/${first}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL });
  assert.deepEqual([late.status, late.text], [409, '{"error":"mcp_login_inactive"}']);
  const secondPid = await readPid(state.codex);
  assert.notEqual(secondPid, firstPid);
  assert.deepEqual((await state.call('DELETE', `${codex}/${second}`)).body, { version: 1 });
  await assertTreeReaped(state.codex);
  assert.equal(state.services.mcpServerManagement!.working, false);
  const cancelled = await state.call('GET', `${codex}/${second}`);
  assert.deepEqual([cancelled.status, cancelled.text], [409, '{"error":"mcp_login_inactive"}']);
  assert.deepEqual((await state.call('GET', `${claude}/${first}`)).body, { version: 1, state: 'failed' });

  const expiring = await managementRunner(t, { loginDeadlineMs: 300 });
  const third = loginIdOf(await expiring.call('POST', claude, signIn()));
  await eventually(() => expiring.call('GET', `${claude}/${third}`), reply => (reply.body as { state: string }).state === 'failed', 'deadline');
  await eventually(() => expiring.services.mcpServerManagement!.working, working => !working, 'settlement');
  await assertTreeReaped(expiring.claude);
});

test('a Codex callback delivery held open by its listener ends on cancel, replacement and shutdown', async t => {
  const state = await managementRunner(t, { callbackTimeoutMs: 60_000 });
  const listener = await heldListener(t);
  await writeJson(state.codex, 'login.json', codexLoginResult(listener.port));
  const base = '/v1/projects/example/mcp-servers/codex/logins';
  const callbackUrl = `http://127.0.0.1:${listener.port}/callback?code=1`;
  const delivering = async (deliveries: number) => {
    const loginId = loginIdOf(await state.call('POST', base, signIn()));
    const started = Date.now();
    const posting = state.call('POST', `${base}/${loginId}/callback`, { callbackUrl });
    await eventually(() => listener.requests.length, count => count === deliveries, 'delivery');
    assert.equal(listener.open(), 1);
    const settled = async (status: number, error: string) => {
      const reply = await posting;
      assert.deepEqual([reply.status, reply.text], [status, `{"error":"${error}"}`]);
      assert.ok(Date.now() - started < 10_000, String(Date.now() - started));
      await eventually(listener.open, open => open === 0, 'socket');
    };
    return { loginId, settled };
  };
  const cancelled = await delivering(1);
  assert.deepEqual((await state.call('DELETE', `${base}/${cancelled.loginId}`)).body, { version: 1 });
  await cancelled.settled(409, 'mcp_login_inactive');

  const replaced = await delivering(2);
  const next = loginIdOf(await state.call('POST', '/v1/projects/second/mcp-servers/claude/logins', signIn()));
  await replaced.settled(409, 'mcp_login_inactive');
  assert.deepEqual((await state.call('GET', `${base}/${replaced.loginId}`)).body, { version: 1, state: 'failed' });
  assert.deepEqual((await state.call('DELETE', `/v1/projects/second/mcp-servers/claude/logins/${next}`)).body, { version: 1 });

  const closing = await delivering(3);
  await state.services.close();
  assert.equal(listener.open(), 0);
  await closing.settled(503, 'storage_unavailable');
  await assertTreeReaped(state.codex);
});

test('a pending login blocks the idle maintenance lease and its state stays readable under a held lease', async t => {
  const state = await managementRunner(t);
  const base = '/v1/projects/example/mcp-servers/claude/logins';
  const leaseId = randomUUID();
  const loginId = loginIdOf(await state.call('POST', base, signIn()));
  const refused = await state.call('POST', '/v1/maintenance/prepare', { leaseId });
  assert.deepEqual([refused.status, refused.body], [409, { error: 'conflict' }]);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'pending' });
  await writeJson(state.claude, 'status.json', claudeStatus('docs', 'connected'));
  await eventually(() => state.services.mcpServerManagement!.working, working => !working, 'settlement');
  assert.equal((await state.call('POST', '/v1/maintenance/prepare', { leaseId })).status, 200);
  assert.deepEqual((await state.call('GET', `${base}/${loginId}`)).body, { version: 1, state: 'succeeded' });
  for (const [method, path, body] of [['POST', '/v1/projects/example/mcp-servers/claude/changes', addition()], ['POST', base, signIn()],
    ['POST', `${base}/${loginId}/callback`, { callbackUrl: CLAUDE_CALLBACK_URL }], ['DELETE', `${base}/${loginId}`, undefined]] as const) {
    const fenced = await state.call(method, path, body);
    assert.deepEqual([fenced.status, fenced.body], [503, { error: 'busy' }], `${method} ${path}`);
  }
  assert.deepEqual((await state.call('DELETE', `/v1/maintenance/${leaseId}`)).body, { leaseId, released: true });
  assert.deepEqual((await state.call('DELETE', `${base}/${loginId}`)).body, { version: 1 });
});

test('a client that drops while a login starts and a runner shutdown reap the provider process tree', async t => {
  const state = await managementRunner(t);
  const base = '/v1/projects/example/mcp-servers/claude/logins';
  await writeFile(join(state.claude, 'hang'), '');
  const client = new AbortController();
  const dropped = assert.rejects(fetch(state.base + base, { method: 'POST', headers: { ...state.headers, 'content-type': 'application/json' }, body: JSON.stringify(signIn()), signal: client.signal }), { name: 'AbortError' });
  const first = await readPid(state.claude);
  client.abort();
  await dropped;
  await assertTreeReaped(state.claude);
  await eventually(() => state.services.mcpServerManagement!.working, working => !working, 'settlement');
  await rm(join(state.claude, 'hang'));
  await rm(join(state.claude, 'pid'));
  await rm(join(state.claude, 'descendant-pid'));

  const loginId = loginIdOf(await state.call('POST', base, signIn()));
  assert.notEqual(await readPid(state.claude), first);
  await readPid(state.claude, 'descendant-pid');
  await state.services.close();
  await assertTreeReaped(state.claude);
  assert.equal(state.services.mcpServerManagement!.working, false);
  const closed = await state.call('GET', `${base}/${loginId}`);
  assert.deepEqual([closed.status, closed.text], [503, '{"error":"storage_unavailable"}']);
  assert.equal((await stdinRequests(state.claude)).some(request => JSON.stringify(request).includes('"user"')), false);
});
