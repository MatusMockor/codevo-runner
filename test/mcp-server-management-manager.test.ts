import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import type { McpServerLoginAttempt, McpServerLoginProcess } from '../src/application/mcp-server-management-service.js';
import { RunnerError } from '../src/domain/contracts.js';
import {
  CliMcpServerManager, MCP_SERVER_CALLBACK_TIMEOUT_MS, MCP_SERVER_CHANGE_TIMEOUT_MS, MCP_SERVER_LOGIN_DEADLINE_MS, MCP_SERVER_MANAGEMENT_BYTES,
  type McpServerManagementCliOptions,
} from '../src/infrastructure/execution/mcp-server-management.js';
import {
  CLAUDE_AUTH_URL, CLAUDE_CALLBACK_URL, SECRET, callbackListener, claudeAwaiting, claudeBrowser, claudeNothing, claudeStatus, codexAuthUrl, codexCompleted,
  codexLoginResult, eventually, heldListener, managementWorkspace, stdinRequests, type ManagementWorkspace,
} from './mcp-server-management-fixture.js';
import { CLAUDE_INITIALIZE_LINE, CLAUDE_MCP_ARGS, CODEX_INITIALIZE_LINE, assertReaped, assertTreeReaped, lines, readPid, writeJson } from './mcp-servers-fixture.js';

const FAST = { retryMs: 10, locateMs: 150, pollMs: 30, startMs: 4_000 };
const ALLOWED_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'PWD', 'OLDPWD', 'SHLVL', '_'];
const HOSTILE = ['--scope', '-e', 'EVIL=1', '--', '--help', '$(touch pwned)', '; rm -rf /', 'a b', '"quoted"', "it's"];
const open = () => new AbortController().signal;
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
const coded = (code: string) => ({ name: 'RunnerError', code });
const unavailable = (error: unknown) => error instanceof Error && !(error instanceof RunnerError);
const control = (requestId: string, request: Readonly<Record<string, unknown>>) => ({ type: 'control_request', request_id: requestId, request });

async function scenario(t: TestContext, options: McpServerManagementCliOptions = {}) {
  const workspace = await managementWorkspace(t);
  const manager = new CliMcpServerManager({ claudeExecutable: workspace.claudeExecutable, codexExecutable: workspace.codexExecutable, timing: FAST, ...options });
  return { ...workspace, manager };
}
async function environment(root: string): Promise<ReadonlyMap<string, string>> {
  return new Map((await lines(root, 'env')).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
}
function pending(attempt: McpServerLoginAttempt): McpServerLoginProcess {
  assert.equal(attempt.kind, 'awaitingCallback');
  assert.ok(attempt.kind === 'awaitingCallback');
  return attempt.process;
}
async function claudeLogin(t: TestContext, name = 'docs', options: McpServerManagementCliOptions = {}) {
  const state = await scenario(t, options);
  await writeJson(state.claude, 'authenticate.json', claudeAwaiting);
  await writeJson(state.claude, 'status.json', claudeStatus(name, 'needs-auth'));
  const cancellation = new AbortController();
  const attempt = await state.manager.login('claude', { name, mode: 'signIn' }, state.workdir, cancellation.signal);
  return { ...state, cancellation, attempt, process: pending(attempt) };
}
async function codexLogin(t: TestContext, state: ManagementWorkspace & { manager: CliMcpServerManager }, port: number, mode: 'signIn' | 'signInAgain' = 'signIn') {
  await writeJson(state.codex, 'login.json', codexLoginResult(port));
  const cancellation = new AbortController();
  t.after(() => cancellation.abort());
  const attempt = await state.manager.login('codex', { name: 'docs', mode }, state.workdir, cancellation.signal);
  return { cancellation, attempt, process: pending(attempt) };
}

test('management limits match the contract', () => {
  assert.deepEqual([MCP_SERVER_CHANGE_TIMEOUT_MS, MCP_SERVER_LOGIN_DEADLINE_MS, MCP_SERVER_CALLBACK_TIMEOUT_MS], [20_000, 300_000, 10_000]);
  assert.deepEqual(MCP_SERVER_MANAGEMENT_BYTES, { cliOutputBytes: 65_536, callbackResponseBytes: 65_536, loginOutputBytes: { claude: 512 * 1024 * 1024, codex: 16 * 1024 * 1024 } });
  for (const options of [{ timeoutMs: 0 }, { loginDeadlineMs: Number.NaN }, { callbackTimeoutMs: -1 }, { timing: { pollMs: 0 } }, { timing: { startMs: Number.POSITIVE_INFINITY } }])
    assert.throws(() => new CliMcpServerManager(options), { message: 'invalid_mcp_server_management_timing' }, JSON.stringify(options));
  assert.throws(() => new CliMcpServerManager({ claudeExecutable: 'relative/claude' }), { message: 'invalid_provider_executable' });
});

test('Claude add runs one typed argv in the pinned checkout and a second add of the name already exists', async t => {
  const { manager, workdir, claude } = await scenario(t);
  const baseline = timers();
  process.env.CODEVO_MCP_TEST_SECRET = SECRET;
  t.after(() => { delete process.env.CODEVO_MCP_TEST_SECRET; });
  await manager.change('claude', { kind: 'add', name: '_x-1', scope: 'local', launch: { kind: 'stdio', command: '--scope', args: HOSTILE } }, workdir, open());
  assert.deepEqual(await lines(claude, 'args-1'), ['mcp', 'add', '--scope', 'local', '--transport', 'stdio', '--', '_x-1', '--scope', ...HOSTILE]);
  assert.deepEqual(await lines(claude, 'cwd'), [workdir.cwd]);
  assert.deepEqual(await lines(workdir.cwd, 'pwned'), []);
  const env = await environment(claude);
  assert.deepEqual([...env.keys()].filter(key => !ALLOWED_ENVIRONMENT.includes(key)), []);
  assert.equal(env.has('PATH'), true);
  await assertTreeReaped(claude);

  await manager.change('claude', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp?x=--scope' } }, workdir, open());
  assert.deepEqual(await lines(claude, 'args-2'), ['mcp', 'add', '--scope', 'user', '--transport', 'http', '--', 'web', 'https://mcp.example.com/mcp?x=--scope']);
  await manager.change('claude', { kind: 'add', name: 'events', scope: 'local', launch: { kind: 'sse', url: 'http://127.0.0.1:9/sse' } }, workdir, open());
  assert.deepEqual(await lines(claude, 'args-3'), ['mcp', 'add', '--scope', 'local', '--transport', 'sse', '--', 'events', 'http://127.0.0.1:9/sse']);
  await assert.rejects(manager.change('claude', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://other.example.com/mcp' } }, workdir, open()), coded('mcp_server_exists'));
  assert.equal((await lines(claude, 'launches')).length, 4);
  assert.deepEqual(await lines(claude, 'stdin'), []);
  await assertTreeReaped(claude);
  assert.equal(timers(), baseline);
});

test('Claude remove reports a missing server and any other failure only as unavailable', async t => {
  const { manager, workdir, claude } = await scenario(t);
  await manager.change('claude', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open());
  await manager.change('claude', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open());
  assert.deepEqual(await lines(claude, 'args-2'), ['mcp', 'remove', '--scope', 'user', '--', 'web']);
  await assert.rejects(manager.change('claude', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), coded('mcp_server_not_found'));
  await assert.rejects(manager.change('claude', { kind: 'remove', name: 'web', scope: 'project' }, workdir, open()), coded('mcp_server_not_found'));
  assert.deepEqual(await lines(claude, 'args-4'), ['mcp', 'remove', '--scope', 'project', '--', 'web']);

  await writeFile(join(claude, 'cli-fail'), `No MCP server named "other" in user scope\nMCP server other already exists in user config\nfailed /home/${SECRET}\n`);
  await assert.rejects(manager.change('claude', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), unavailable);
  await assert.rejects(manager.change('claude', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), unavailable);
  await writeFile(join(claude, 'cli-fail'), 'x'.repeat(MCP_SERVER_MANAGEMENT_BYTES.cliOutputBytes + 1));
  await assert.rejects(manager.change('claude', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), unavailable);
  await assertTreeReaped(claude);
});

test('a change that outlives its timeout, a cancelled change and a changed checkout are unavailable and reaped', async t => {
  const { manager, workdir, claude, codex, claudeExecutable, codexExecutable } = await scenario(t, { timeoutMs: 300 });
  const baseline = timers();
  await writeFile(join(claude, 'hang'), '');
  await writeFile(join(codex, 'hang'), '');
  const started = Date.now();
  await assert.rejects(manager.change('claude', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), unavailable);
  assert.ok(Date.now() - started >= 250 && Date.now() - started < 6_000);
  await assertTreeReaped(claude);
  await assert.rejects(manager.change('claude', { kind: 'signOut', name: 'web' }, workdir, open()), unavailable);
  await assertTreeReaped(claude);
  await assert.rejects(manager.change('codex', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), unavailable);
  await assertTreeReaped(codex);
  await assert.rejects(manager.change('codex', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), unavailable);
  await assertTreeReaped(codex);

  const patient = new CliMcpServerManager({ claudeExecutable, codexExecutable, timing: FAST });
  const cancellation = new AbortController();
  await rm(join(codex, 'pid'));
  const cancelled = assert.rejects(patient.change('codex', { kind: 'signOut', name: 'web' }, workdir, cancellation.signal), unavailable);
  await readPid(codex);
  cancellation.abort();
  await cancelled;
  await assertTreeReaped(codex);

  await rm(join(claude, 'hang'));
  const launches = (await lines(claude, 'launches')).length;
  await assert.rejects(patient.change('claude', { kind: 'remove', name: 'web', scope: 'user' }, { cwd: workdir.cwd, identity: { dev: workdir.identity.dev, ino: workdir.identity.ino + 1 } }, open()), unavailable);
  assert.equal((await lines(claude, 'launches')).length, launches);
  assert.equal(timers(), baseline);
});

test('Claude sign-out clears the authorization in a status session and maps control errors', async t => {
  const { manager, workdir, claude } = await scenario(t);
  const baseline = timers();
  await manager.change('claude', { kind: 'signOut', name: 'claude.ai Gmail' }, workdir, open());
  assert.deepEqual(await lines(claude, 'args-1'), CLAUDE_MCP_ARGS);
  assert.deepEqual(await lines(claude, 'cwd'), [workdir.cwd]);
  assert.deepEqual(await lines(claude, 'stdin'), [CLAUDE_INITIALIZE_LINE,
    JSON.stringify(control('codevo-mcp-clear-auth-1', { subtype: 'mcp_clear_auth', serverName: 'claude.ai Gmail' }))]);
  const env = await environment(claude);
  assert.deepEqual([env.get('CLAUDE_CODE_AUTO_CONNECT_IDE'), env.get('CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL')], ['0', '1']);
  assert.deepEqual([...env.keys()].filter(key => ![...ALLOWED_ENVIRONMENT, 'CLAUDE_CODE_AUTO_CONNECT_IDE', 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL'].includes(key)), []);
  await assertTreeReaped(claude);

  await writeFile(join(claude, 'clear-auth-error'), 'Server not found: docs');
  await assert.rejects(manager.change('claude', { kind: 'signOut', name: 'docs' }, workdir, open()), coded('mcp_server_not_found'));
  assert.ok((await stdinRequests(claude)).filter(request => JSON.stringify(request).includes('"serverName":"docs"')).length >= 2);
  await writeFile(join(claude, 'clear-auth-error'), 'Cannot clear auth for this server type');
  await assert.rejects(manager.change('claude', { kind: 'signOut', name: 'docs' }, workdir, open()), coded('mcp_change_unsupported'));
  await rm(join(claude, 'clear-auth-error'));
  await writeFile(join(claude, 'initialize-error'), 'not ready');
  await assert.rejects(manager.change('claude', { kind: 'signOut', name: 'docs' }, workdir, open()), unavailable);
  await assertTreeReaped(claude);
  assert.equal(timers(), baseline);
});

test('Codex add checks the configuration in the same app-server session and never replaces an existing server', async t => {
  const { manager, workdir, codex } = await scenario(t);
  const baseline = timers();
  await writeJson(codex, 'config.json', { result: { config: { mcp_servers: { other: { url: `https://other.example.com/${SECRET}` } } }, origins: {} } });
  await writeJson(codex, 'write.json', { result: { status: 'ok', version: 'sha256:1', filePath: `/home/${SECRET}/.codex/config.toml`, overriddenMetadata: null } });
  await manager.change('codex', { kind: 'add', name: 'docs-1', scope: 'user', launch: { kind: 'stdio', command: '--weird', args: ['--a b', '--', 'c"d'] } }, workdir, open());
  assert.deepEqual(await lines(codex, 'args-1'), ['app-server', '--stdio']);
  assert.deepEqual(await lines(codex, 'cwd'), [workdir.cwd]);
  assert.deepEqual(await lines(codex, 'stdin'), [CODEX_INITIALIZE_LINE, '{"method":"initialized","params":{}}',
    JSON.stringify({ id: 1, method: 'config/read', params: { cwd: workdir.cwd, includeLayers: false } }),
    JSON.stringify({ id: 2, method: 'config/batchWrite', params: { edits: [{ keyPath: 'mcp_servers.docs-1', mergeStrategy: 'replace', value: { command: '--weird', args: ['--a b', '--', 'c"d'] } }] } })]);
  assert.deepEqual([...(await environment(codex)).keys()].filter(key => !ALLOWED_ENVIRONMENT.includes(key)), []);
  await assertTreeReaped(codex);

  await rm(join(codex, 'stdin'));
  await assert.rejects(manager.change('codex', { kind: 'add', name: 'other', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), coded('mcp_server_exists'));
  assert.equal((await lines(codex, 'stdin')).some(entry => entry.includes('config/batchWrite')), false);
  await writeJson(codex, 'write.json', { error: { code: -32600, message: `invalid ${SECRET}` } });
  await assert.rejects(manager.change('codex', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), unavailable);
  await writeJson(codex, 'config.json', { error: { code: -32603, message: 'unreadable' } });
  await rm(join(codex, 'stdin'));
  await assert.rejects(manager.change('codex', { kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, workdir, open()), unavailable);
  assert.equal((await lines(codex, 'stdin')).some(entry => entry.includes('config/batchWrite')), false);
  await assertTreeReaped(codex);
  assert.equal(timers(), baseline);
});

test('Codex remove and sign-out are plain CLI calls with every outcome classified', async t => {
  const { manager, workdir, codex } = await scenario(t);
  await writeFile(join(codex, 'configured', 'web'), '');
  await manager.change('codex', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open());
  assert.deepEqual(await lines(codex, 'args-1'), ['mcp', 'remove', '--', 'web']);
  await assert.rejects(manager.change('codex', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), coded('mcp_server_not_found'));

  await manager.change('codex', { kind: 'signOut', name: '--help' }, workdir, open());
  assert.deepEqual(await lines(codex, 'args-3'), ['mcp', 'logout', '--', '--help']);
  await writeFile(join(codex, 'logout-exit'), '1');
  await writeFile(join(codex, 'logout-output'), "Error: No MCP server named 'web' found in configuration.\n");
  await assert.rejects(manager.change('codex', { kind: 'signOut', name: 'web' }, workdir, open()), coded('mcp_server_not_found'));
  await writeFile(join(codex, 'logout-output'), 'Error: OAuth logout is only supported for streamable_http transports.\n');
  await assert.rejects(manager.change('codex', { kind: 'signOut', name: 'web' }, workdir, open()), coded('mcp_change_unsupported'));
  await writeFile(join(codex, 'logout-output'), `Error: keyring ${SECRET}\n`);
  await assert.rejects(manager.change('codex', { kind: 'signOut', name: 'web' }, workdir, open()), unavailable);
  await writeFile(join(codex, 'cli-fail'), 'boom\n');
  await assert.rejects(manager.change('codex', { kind: 'remove', name: 'web', scope: 'user' }, workdir, open()), unavailable);
  assert.deepEqual(await lines(codex, 'stdin'), []);
  await assertTreeReaped(codex);
});

test('Claude login maps the three authenticate answers and control errors, keeping only a callback login alive', async t => {
  const { manager, workdir, claude } = await scenario(t);
  const baseline = timers();
  await writeJson(claude, 'authenticate.json', claudeNothing);
  assert.deepEqual(await manager.login('claude', { name: 'docs', mode: 'signIn' }, workdir, open()), { kind: 'completed' });
  assert.deepEqual(await lines(claude, 'args-1'), CLAUDE_MCP_ARGS);
  assert.deepEqual(await lines(claude, 'stdin'), [CLAUDE_INITIALIZE_LINE, JSON.stringify(control('codevo-mcp-authenticate-1', { subtype: 'mcp_authenticate', serverName: 'docs' }))]);
  await assertTreeReaped(claude);

  await rm(join(claude, 'stdin'));
  await writeJson(claude, 'authenticate.json', claudeBrowser);
  assert.deepEqual(await manager.login('claude', { name: 'claude.ai Gmail', mode: 'signInAgain' }, workdir, open()), { kind: 'finishInBrowser', authorizationUrl: claudeBrowser.authUrl });
  assert.deepEqual(await stdinRequests(claude), [JSON.parse(CLAUDE_INITIALIZE_LINE), control('codevo-mcp-clear-auth-1', { subtype: 'mcp_clear_auth', serverName: 'claude.ai Gmail' }),
    control('codevo-mcp-authenticate-1', { subtype: 'mcp_authenticate', serverName: 'claude.ai Gmail' })]);
  await assertTreeReaped(claude);

  await writeFile(join(claude, 'authenticate-error'), 'Server type stdio does not support OAuth authentication');
  await assert.rejects(manager.login('claude', { name: 'docs', mode: 'signIn' }, workdir, open()), coded('mcp_login_unsupported'));
  await writeFile(join(claude, 'authenticate-error'), 'Server not found: docs');
  await assert.rejects(manager.login('claude', { name: 'docs', mode: 'signIn' }, workdir, open()), coded('mcp_server_not_found'));
  await rm(join(claude, 'authenticate-error'));
  await writeJson(claude, 'authenticate.json', { authUrl: 'http://evil.example.com/authorize', requiresUserAction: true, callbackExpected: true });
  await assert.rejects(manager.login('claude', { name: 'docs', mode: 'signIn' }, workdir, open()), unavailable);
  await writeFile(join(claude, 'initialize-error'), 'not ready');
  await assert.rejects(manager.login('claude', { name: 'docs', mode: 'signIn' }, workdir, open()), unavailable);
  await assertTreeReaped(claude);
  assert.equal(timers(), baseline);
});

test('a Claude callback login stays pending, polls the status and succeeds once the server is connected', async t => {
  const baseline = timers();
  const { claude, attempt, process: login } = await claudeLogin(t);
  assert.deepEqual({ kind: attempt.kind, authorizationUrl: attempt.kind === 'awaitingCallback' ? attempt.authorizationUrl : null }, { kind: 'awaitingCallback', authorizationUrl: CLAUDE_AUTH_URL });
  assert.equal(login.state(), 'pending');
  const pid = await readPid(claude);
  await eventually(() => stdinRequests(claude), requests => requests.filter(request => JSON.stringify(request).includes('mcp_status')).length >= 3, 'status polls');
  assert.equal(login.state(), 'pending');
  assert.doesNotThrow(() => process.kill(pid, 0));
  await writeJson(claude, 'status.json', claudeStatus('docs', 'connected'));
  await login.finished;
  assert.equal(login.state(), 'succeeded');
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), false);
  await assertTreeReaped(claude);
  const requests = await stdinRequests(claude);
  assert.deepEqual(requests.slice(0, 3), [JSON.parse(CLAUDE_INITIALIZE_LINE), control('codevo-mcp-authenticate-1', { subtype: 'mcp_authenticate', serverName: 'docs' }),
    control('codevo-mcp-login-status-1', { subtype: 'mcp_status' })]);
  assert.equal(requests.some(request => JSON.stringify(request).includes('"user"')), false);
  assert.equal(timers(), baseline);
});

test('a pasted Claude callback is accepted or rejected through mcp_oauth_callback_url and a failed status then fails the login', async t => {
  const { claude, process: login } = await claudeLogin(t, 'docs', { callbackTimeoutMs: 2_000 });
  await writeFile(join(claude, 'callback-error'), 'Callback URL not accepted: it belongs to a different sign-in attempt');
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), false);
  assert.equal(login.state(), 'pending');
  await rm(join(claude, 'callback-error'));
  await writeJson(claude, 'status.json', claudeStatus('docs', 'failed'));
  await eventually(() => stdinRequests(claude), requests => requests.filter(request => JSON.stringify(request).includes('mcp_status')).length >= 3, 'status polls');
  assert.equal(login.state(), 'pending');
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), true);
  await login.finished;
  assert.equal(login.state(), 'failed');
  await assertTreeReaped(claude);
  const callbacks = (await stdinRequests(claude)).filter(request => JSON.stringify(request).includes('mcp_oauth_callback_url'));
  assert.deepEqual(callbacks, [control('codevo-mcp-oauth-callback-1', { subtype: 'mcp_oauth_callback_url', serverName: 'docs', callbackUrl: CLAUDE_CALLBACK_URL }),
    control('codevo-mcp-oauth-callback-2', { subtype: 'mcp_oauth_callback_url', serverName: 'docs', callbackUrl: CLAUDE_CALLBACK_URL })]);
});

test('an unanswered Claude callback is rejected after its timeout without leaking a timer', async t => {
  const baseline = timers();
  const { claude, cancellation, process: login } = await claudeLogin(t, 'docs', { callbackTimeoutMs: 200 });
  await writeFile(join(claude, 'callback-silent'), '');
  const started = Date.now();
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), false);
  assert.ok(Date.now() - started >= 150 && Date.now() - started < 5_000, String(Date.now() - started));
  assert.equal(login.state(), 'pending');
  const repeated = Date.now();
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), false);
  assert.ok(Date.now() - repeated < 150, String(Date.now() - repeated));
  assert.equal((await stdinRequests(claude)).filter(request => JSON.stringify(request).includes('mcp_oauth_callback_url')).length, 1);
  cancellation.abort();
  await login.finished;
  assert.equal(login.state(), 'failed');
  assert.equal(await login.submitCallback(CLAUDE_CALLBACK_URL), false);
  await assertTreeReaped(claude);
  assert.equal(timers(), baseline);
});

test('a cancelled login, a login past its deadline and a login that never starts are reaped', async t => {
  const baseline = timers();
  const cancelled = await claudeLogin(t);
  const first = await readPid(cancelled.claude);
  cancelled.cancellation.abort();
  await cancelled.process.finished;
  assert.equal(cancelled.process.state(), 'failed');
  await assertReaped(first);
  await assertTreeReaped(cancelled.claude);

  const expiring = await claudeLogin(t, 'docs', { loginDeadlineMs: 200 });
  const started = Date.now();
  assert.equal(expiring.process.state(), 'pending');
  await expiring.process.finished;
  assert.ok(Date.now() - started >= 900 && Date.now() - started < 8_000, String(Date.now() - started));
  assert.equal(expiring.process.state(), 'failed');
  await assertTreeReaped(expiring.claude);

  const silent = await scenario(t, { timing: { ...FAST, startMs: 250 } });
  await writeFile(join(silent.claude, 'hang'), '');
  await writeFile(join(silent.codex, 'hang'), '');
  await assert.rejects(silent.manager.login('claude', { name: 'docs', mode: 'signIn' }, silent.workdir, open()), unavailable);
  await assertTreeReaped(silent.claude);
  await assert.rejects(silent.manager.login('codex', { name: 'docs', mode: 'signIn' }, silent.workdir, open()), unavailable);
  await assertTreeReaped(silent.codex);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(silent.manager.login('claude', { name: 'docs', mode: 'signIn' }, silent.workdir, aborted.signal), unavailable);
  assert.equal(timers(), baseline);
});

test('Codex login starts a 300 second OAuth login and succeeds on its completion notification', async t => {
  const state = await scenario(t);
  const baseline = timers();
  const { attempt, process: login } = await codexLogin(t, state, 45_679);
  assert.deepEqual({ kind: attempt.kind, authorizationUrl: attempt.kind === 'awaitingCallback' ? attempt.authorizationUrl : null }, { kind: 'awaitingCallback', authorizationUrl: codexAuthUrl(45_679) });
  assert.equal(login.state(), 'pending');
  assert.deepEqual(await lines(state.codex, 'args-1'), ['app-server', '--stdio']);
  assert.deepEqual(await lines(state.codex, 'stdin'), [CODEX_INITIALIZE_LINE, '{"method":"initialized","params":{}}',
    '{"id":1,"method":"mcpServer/oauth/login","params":{"name":"docs","timeoutSecs":300}}']);
  await writeJson(state.codex, 'completed.json', codexCompleted('docs', true));
  await login.finished;
  assert.equal(login.state(), 'succeeded');
  await assertTreeReaped(state.codex);
  assert.equal(timers(), baseline);

  await rm(join(state.codex, 'completed.json'));
  const failing = await codexLogin(t, state, 45_679);
  await writeJson(state.codex, 'completed.json', codexCompleted('docs', false));
  await failing.process.finished;
  assert.equal(failing.process.state(), 'failed');
  await assertTreeReaped(state.codex);
});

test('Codex sign-in again logs out first, tolerating a failed logout, and login errors are mapped', async t => {
  const state = await scenario(t);
  await writeFile(join(state.codex, 'logout-exit'), '1');
  await writeFile(join(state.codex, 'logout-output'), 'Error: keyring unavailable\n');
  const { cancellation, process: login } = await codexLogin(t, state, 45_679, 'signInAgain');
  assert.deepEqual([await lines(state.codex, 'args-1'), await lines(state.codex, 'args-2')], [['mcp', 'logout', '--', 'docs'], ['app-server', '--stdio']]);
  assert.equal(login.state(), 'pending');
  cancellation.abort();
  await login.finished;
  assert.equal(login.state(), 'failed');
  await assertTreeReaped(state.codex);

  await writeJson(state.codex, 'login.json', { error: { code: -32600, message: "No MCP server named 'docs' found." } });
  await assert.rejects(state.manager.login('codex', { name: 'docs', mode: 'signIn' }, state.workdir, open()), coded('mcp_server_not_found'));
  assert.equal((await lines(state.codex, 'launches')).length, 3);
  await writeJson(state.codex, 'login.json', { error: { code: -32600, message: 'OAuth login is only supported for streamable HTTP servers.' } });
  await assert.rejects(state.manager.login('codex', { name: 'docs', mode: 'signIn' }, state.workdir, open()), coded('mcp_login_unsupported'));
  await writeJson(state.codex, 'login.json', { result: { authorizationUrl: `http://evil.example.com/authorize?state=${SECRET}`, loginId: 'L1' } });
  await assert.rejects(state.manager.login('codex', { name: 'docs', mode: 'signIn' }, state.workdir, open()), unavailable);
  await writeFile(join(state.codex, 'initialize-error'), '');
  await assert.rejects(state.manager.login('codex', { name: 'docs', mode: 'signIn' }, state.workdir, open()), unavailable);
  await assertTreeReaped(state.codex);
});

test('a pasted Codex callback issues exactly one loopback GET to the redirect of the session and follows no redirect', async t => {
  const state = await scenario(t, { callbackTimeoutMs: 2_000 });
  const listener = await callbackListener(t, 200, () => { void writeJson(state.codex, 'completed.json', codexCompleted('docs', true)); });
  const { process: login } = await codexLogin(t, state, listener.port);
  for (const callbackUrl of [`http://127.0.0.1:${listener.port + 1}/callback?code=1`, `http://127.0.0.1/callback?code=1`, `http://127.0.0.1:${listener.port}/other?code=1`,
    `http://127.0.0.1:${listener.port}/callback/extra?code=1`, `http://127.0.0.1:${listener.port}//callback?code=1`])
    assert.equal(await login.submitCallback(callbackUrl), false, callbackUrl);
  assert.deepEqual(listener.requests, []);
  assert.equal(login.state(), 'pending');
  assert.equal(await login.submitCallback(`http://localhost:${listener.port}/callback?code=a%20b&state=c%26d#fragment`), true);
  assert.deepEqual(listener.requests, [`GET /callback?code=a%20b&state=c%26d 127.0.0.1:${listener.port}`]);
  await login.finished;
  assert.equal(login.state(), 'succeeded');
  assert.equal(await login.submitCallback(`http://127.0.0.1:${listener.port}/callback?code=1`), false);
  assert.equal(listener.requests.length, 1);
  await assertTreeReaped(state.codex);
});

test('a Codex callback the listener refuses, redirects or never answers is rejected', async t => {
  const baseline = timers();
  const state = await scenario(t, { callbackTimeoutMs: 300 });
  const refusing = await callbackListener(t, 400);
  const first = await codexLogin(t, state, refusing.port);
  assert.equal(await first.process.submitCallback(`http://127.0.0.1:${refusing.port}/callback?error=access_denied`), false);
  assert.deepEqual(refusing.requests, [`GET /callback?error=access_denied 127.0.0.1:${refusing.port}`]);
  first.cancellation.abort();
  await first.process.finished;

  const redirecting = await callbackListener(t, 302);
  const second = await codexLogin(t, state, redirecting.port);
  assert.equal(await second.process.submitCallback(`http://127.0.0.1:${redirecting.port}/callback?code=1`), false);
  assert.equal(redirecting.requests.length, 1);
  redirecting.server.closeAllConnections();
  await new Promise<void>(resolve => redirecting.server.close(() => resolve()));
  assert.equal(await second.process.submitCallback(`http://127.0.0.1:${redirecting.port}/callback?code=1`), false);
  second.cancellation.abort();
  await second.process.finished;

  let hanging = 0;
  const silent = await callbackListener(t);
  silent.server.removeAllListeners('request');
  silent.server.on('request', () => { hanging++; });
  const third = await codexLogin(t, state, silent.port);
  const started = Date.now();
  assert.equal(await third.process.submitCallback(`http://127.0.0.1:${silent.port}/callback?code=1`), false);
  assert.ok(Date.now() - started >= 250 && Date.now() - started < 5_000);
  assert.equal(hanging, 1);
  third.cancellation.abort();
  await third.process.finished;
  await assertTreeReaped(state.codex);
  assert.equal(timers(), baseline);
});

test('a Codex callback answer that is oversized, stalls or is cut short is rejected even after 200 headers', async t => {
  const baseline = timers();
  const state = await scenario(t, { callbackTimeoutMs: 400 });
  const bound = MCP_SERVER_MANAGEMENT_BYTES.callbackResponseBytes;
  const answers: ReadonlyArray<readonly [string, boolean, (response: ServerResponse) => void]> = [
    ['complete at the bound', true, response => { response.writeHead(200); response.end(Buffer.alloc(bound, 0x61)); }],
    ['oversized', false, response => { response.writeHead(200); response.end(Buffer.alloc(bound + 1, 0x61)); }],
    ['oversized stream', false, response => { response.writeHead(200); response.write(Buffer.alloc(bound, 0x61)); response.write('a'); }],
    ['stalled', false, response => { response.writeHead(200); response.write('Authentication'); }],
    ['stalled headers', false, response => { response.writeHead(200); response.flushHeaders(); }],
    ['cut short', false, response => { response.writeHead(200, { 'content-length': '100' }); response.write('partial', () => response.socket?.destroy()); }],
    ['cut short chunked', false, response => { response.writeHead(200); response.write('partial', () => response.socket?.destroy()); }],
  ];
  for (const [label, accepted, respond] of answers) {
    const listener = await heldListener(t, respond);
    const { cancellation, process: login } = await codexLogin(t, state, listener.port);
    const started = Date.now();
    assert.equal(await login.submitCallback(`http://127.0.0.1:${listener.port}/callback?code=1`), accepted, label);
    if (label.startsWith('stalled')) assert.ok(Date.now() - started >= 350, `${label} ${Date.now() - started}`);
    assert.ok(Date.now() - started < 5_000, label);
    assert.deepEqual(listener.requests, ['GET /callback?code=1'], label);
    await eventually(listener.open, open => open === 0, `${label} socket`);
    assert.equal(login.state(), 'pending', label);
    cancellation.abort();
    await login.finished;
  }
  await assertTreeReaped(state.codex);
  assert.equal(timers(), baseline);
});

test('cancelling a Codex login ends a callback delivery that is still in flight', async t => {
  const baseline = timers();
  const state = await scenario(t, { callbackTimeoutMs: 60_000 });
  for (const respond of [() => undefined, (response: ServerResponse) => { response.writeHead(200); response.write('Authentication'); }]) {
    const listener = await heldListener(t, respond);
    const { cancellation, process: login } = await codexLogin(t, state, listener.port);
    const started = Date.now();
    const delivery = login.submitCallback(`http://127.0.0.1:${listener.port}/callback?code=1`);
    await eventually(() => listener.requests.length, count => count === 1, 'delivery');
    assert.equal(listener.open(), 1);
    cancellation.abort();
    assert.equal(await delivery, false);
    assert.ok(Date.now() - started < 5_000, String(Date.now() - started));
    await login.finished;
    await eventually(listener.open, open => open === 0, 'socket');
    assert.equal(await login.submitCallback(`http://127.0.0.1:${listener.port}/callback?code=1`), false);
    assert.equal(listener.requests.length, 1);
  }
  await assertTreeReaped(state.codex);
  assert.equal(timers(), baseline);
});

test('a Codex redirect that is not a loopback http address never receives a pasted callback', async t => {
  const state = await scenario(t);
  const listener = await callbackListener(t);
  await writeJson(state.codex, 'login.json', { result: { authorizationUrl: `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(`https://relay.example.com:${listener.port}/callback`)}`, loginId: null } });
  const cancellation = new AbortController();
  const login = pending(await state.manager.login('codex', { name: 'docs', mode: 'signIn' }, state.workdir, cancellation.signal));
  assert.equal(await login.submitCallback(`http://127.0.0.1:${listener.port}/callback?code=1`), false);
  assert.deepEqual(listener.requests, []);
  cancellation.abort();
  await login.finished;
  await assertTreeReaped(state.codex);
});
