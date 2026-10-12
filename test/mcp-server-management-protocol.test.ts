import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_MCP_LOGIN_TIMEOUT_SECONDS, ClaudeMcpLogin, ClaudeMcpSignOut, CodexMcpAdd, CodexMcpLogin, MCP_MANAGEMENT_TIMING, claudeMcpAuthenticateRequestId,
  claudeMcpCallbackRequestId, claudeMcpClearAuthRequestId, claudeMcpLoginStatusRequestId, type McpManagementTiming,
} from '../src/domain/mcp-server-management-protocol.js';
import { CLAUDE_MCP_INITIALIZE_REQUEST_ID } from '../src/domain/mcp-servers-probe.js';

const TIMING: McpManagementTiming = { retryMs: 100, locateMs: 1_000, pollMs: 1_500, startMs: 25_000 };
const AUTH_URL = 'https://auth.example.com/authorize?state=s&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback';
const CALLBACK_URL = 'http://localhost:45678/callback?code=c&state=s';
const success = (requestId: string, response: unknown = {}) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
const refusal = (requestId: string, error: string) => JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
const initialized = success(CLAUDE_MCP_INITIALIZE_REQUEST_ID, { commands: [] });
const control = (requestId: string, request: Readonly<Record<string, unknown>>) => ({ type: 'control_request', request_id: requestId, request });
const statusOf = (name: string, status: string) => ({ mcpServers: [{ name: 'other', status: 'failed' }, { name, status }] });
const awaiting = { authUrl: AUTH_URL, requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', state: 's', callbackPort: 45678 };
const codexReady = JSON.stringify({ id: 0, result: { userAgent: 'synthetic' } });
const initializedNotification = { method: 'initialized', params: {} };

function claudeAwaiting(name = 'docs', timing = TIMING) {
  const login = new ClaudeMcpLogin(name, 'signIn', 0, timing);
  login.observe(initialized, 10);
  login.step(10);
  login.observe(success(claudeMcpAuthenticateRequestId(1), awaiting), 20);
  return login;
}

test('management timing polls a login about every 1.5 seconds and bounds its start at 25 seconds', () => {
  assert.deepEqual(MCP_MANAGEMENT_TIMING, { retryMs: 250, locateMs: 8_000, pollMs: 1_500, startMs: 25_000 });
  assert.equal(CODEX_MCP_LOGIN_TIMEOUT_SECONDS, 300);
});

test('Claude sign-out clears the stored authorization once after the handshake', () => {
  const signOut = new ClaudeMcpSignOut('claude.ai Gmail', TIMING);
  assert.deepEqual(signOut.step(0), { kind: 'wait' });
  signOut.observe(success('unrelated'), 1);
  signOut.observe('not json', 1);
  assert.deepEqual(signOut.step(1), { kind: 'wait' });
  signOut.observe(initialized, 5);
  assert.deepEqual(signOut.step(5), { kind: 'write', requests: [control(claudeMcpClearAuthRequestId(1), { subtype: 'mcp_clear_auth', serverName: 'claude.ai Gmail' })] });
  assert.deepEqual(signOut.step(500), { kind: 'wait' });
  signOut.observe(success(claudeMcpClearAuthRequestId(2)), 6);
  assert.deepEqual(signOut.step(6), { kind: 'wait' });
  signOut.observe(success(claudeMcpClearAuthRequestId(1)), 7);
  assert.deepEqual(signOut.step(7), { kind: 'done' });
  signOut.observe(refusal(claudeMcpClearAuthRequestId(1), 'late'), 8);
  assert.deepEqual(signOut.step(8), { kind: 'done' });
});

test('Claude sign-out reports a refused handshake, an unknown server after the locate window and an unsupported server', () => {
  const refused = new ClaudeMcpSignOut('docs', TIMING);
  refused.observe(refusal(CLAUDE_MCP_INITIALIZE_REQUEST_ID, 'nope'), 1);
  assert.deepEqual(refused.step(1), { kind: 'failed', failure: 'handshake' });

  const unknown = new ClaudeMcpSignOut('docs', TIMING);
  unknown.observe(initialized, 0);
  assert.equal(unknown.step(0).kind, 'write');
  unknown.observe(refusal(claudeMcpClearAuthRequestId(1), 'Server not found: docs'), 10);
  assert.deepEqual(unknown.step(50), { kind: 'wait' });
  assert.deepEqual(unknown.step(110), { kind: 'write', requests: [control(claudeMcpClearAuthRequestId(2), { subtype: 'mcp_clear_auth', serverName: 'docs' })] });
  unknown.observe(refusal(claudeMcpClearAuthRequestId(2), 'Server not found: docs'), 999);
  assert.equal(unknown.step(1_099).kind, 'write');
  unknown.observe(refusal(claudeMcpClearAuthRequestId(3), 'Server not found: docs'), 1_100);
  assert.deepEqual(unknown.step(1_100), { kind: 'failed', failure: 'notFound' });

  const late = new ClaudeMcpSignOut('docs', TIMING);
  late.observe(initialized, 0);
  late.step(0);
  late.observe(refusal(claudeMcpClearAuthRequestId(1), 'Server not found: docs'), 10);
  late.step(110);
  late.observe(success(claudeMcpClearAuthRequestId(2)), 120);
  assert.deepEqual(late.step(120), { kind: 'done' });

  for (const error of ['Cannot clear auth for server type "stdio"', 'Server not found: other', 'Server not found: docs2', 'managed by policy']) {
    const unsupported = new ClaudeMcpSignOut('docs', TIMING);
    unsupported.observe(initialized, 0);
    unsupported.step(0);
    unsupported.observe(refusal(claudeMcpClearAuthRequestId(1), error), 1);
    assert.deepEqual(unsupported.step(1), { kind: 'failed', failure: 'unsupported' }, error);
  }
});

test('Claude sign-in authenticates after the handshake and maps the three answers', () => {
  const login = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
  assert.deepEqual([login.step(0), login.progress()], [[], { kind: 'starting' }]);
  login.observe(success(claudeMcpAuthenticateRequestId(1), awaiting), 1);
  assert.deepEqual(login.progress(), { kind: 'starting' });
  login.observe(initialized, 10);
  assert.deepEqual(login.step(10), [control(claudeMcpAuthenticateRequestId(1), { subtype: 'mcp_authenticate', serverName: 'docs' })]);
  assert.deepEqual(login.step(11), []);
  login.observe(success(claudeMcpAuthenticateRequestId(1), awaiting), 20);
  assert.deepEqual(login.progress(), { kind: 'awaitingCallback', authorizationUrl: AUTH_URL });

  const answers: ReadonlyArray<readonly [unknown, unknown]> = [
    [{ authUrl: 'https://claude.ai/connect', requiresUserAction: true, callbackExpected: false }, { kind: 'finishInBrowser', authorizationUrl: 'https://claude.ai/connect' }],
    [{ requiresUserAction: false, callbackExpected: false }, { kind: 'completed' }],
    [{ requiresUserAction: false }, { kind: 'completed' }],
    [{ authUrl: 'http://evil.example.com/authorize', requiresUserAction: true, callbackExpected: true }, { kind: 'failed', failure: 'payload' }],
    [{ authUrl: 'javascript:alert(1)', requiresUserAction: true, callbackExpected: false }, { kind: 'failed', failure: 'payload' }],
    [{ authUrl: `https://auth.example.com/${'a'.repeat(4096)}`, requiresUserAction: true, callbackExpected: true }, { kind: 'failed', failure: 'payload' }],
    [{ requiresUserAction: true, callbackExpected: true }, { kind: 'failed', failure: 'payload' }],
    [{ authUrl: AUTH_URL, requiresUserAction: true }, { kind: 'failed', failure: 'payload' }],
    [{ authUrl: AUTH_URL, callbackExpected: true }, { kind: 'failed', failure: 'payload' }],
    [{ authUrl: AUTH_URL, requiresUserAction: 'yes', callbackExpected: true }, { kind: 'failed', failure: 'payload' }],
    [null, { kind: 'failed', failure: 'payload' }],
    ['ok', { kind: 'failed', failure: 'payload' }],
  ];
  for (const [response, expected] of answers) {
    const other = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
    other.observe(initialized, 10);
    other.step(10);
    other.observe(success(claudeMcpAuthenticateRequestId(1), response), 20);
    assert.deepEqual(other.progress(), expected, JSON.stringify(response));
    assert.deepEqual(other.step(5_000), [], JSON.stringify(response));
  }
});

test('Claude sign-in again clears the authorization first and tolerates a refused clear', () => {
  const login = new ClaudeMcpLogin('docs', 'signInAgain', 0, TIMING);
  login.observe(initialized, 10);
  assert.deepEqual(login.step(10), [control(claudeMcpClearAuthRequestId(1), { subtype: 'mcp_clear_auth', serverName: 'docs' })]);
  assert.deepEqual(login.step(20), []);
  login.observe(success(claudeMcpClearAuthRequestId(1)), 30);
  assert.deepEqual(login.step(30), [control(claudeMcpAuthenticateRequestId(1), { subtype: 'mcp_authenticate', serverName: 'docs' })]);
  login.observe(success(claudeMcpAuthenticateRequestId(1), awaiting), 40);
  assert.equal(login.progress().kind, 'awaitingCallback');

  const tolerant = new ClaudeMcpLogin('docs', 'signInAgain', 0, TIMING);
  tolerant.observe(initialized, 10);
  tolerant.step(10);
  tolerant.observe(refusal(claudeMcpClearAuthRequestId(1), 'Cannot clear auth for server type "stdio"'), 20);
  assert.equal(tolerant.step(20).length, 1);
  tolerant.observe(refusal(claudeMcpAuthenticateRequestId(1), 'Server type "stdio" does not support OAuth authentication'), 30);
  assert.deepEqual(tolerant.progress(), { kind: 'failed', failure: 'unsupported' });

  const unknown = new ClaudeMcpLogin('docs', 'signInAgain', 0, TIMING);
  unknown.observe(initialized, 0);
  unknown.step(0);
  unknown.observe(refusal(claudeMcpClearAuthRequestId(1), 'Server not found: docs'), 1_000);
  assert.deepEqual(unknown.progress(), { kind: 'failed', failure: 'notFound' });
});

test('Claude sign-in retries a server Claude has not loaded yet and reports control errors', () => {
  const login = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
  login.observe(refusal(CLAUDE_MCP_INITIALIZE_REQUEST_ID, 'nope'), 1);
  assert.deepEqual(login.progress(), { kind: 'failed', failure: 'handshake' });

  const loading = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
  loading.observe(initialized, 0);
  loading.step(0);
  loading.observe(refusal(claudeMcpAuthenticateRequestId(1), 'Server not found: docs'), 10);
  assert.deepEqual([loading.progress(), loading.step(50)], [{ kind: 'starting' }, []]);
  assert.deepEqual(loading.step(110), [control(claudeMcpAuthenticateRequestId(2), { subtype: 'mcp_authenticate', serverName: 'docs' })]);
  loading.observe(success(claudeMcpAuthenticateRequestId(2), { requiresUserAction: false, callbackExpected: false }), 120);
  assert.deepEqual(loading.progress(), { kind: 'completed' });

  const unknown = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
  unknown.observe(initialized, 0);
  unknown.step(0);
  unknown.observe(refusal(claudeMcpAuthenticateRequestId(1), 'Server not found: docs'), 1_000);
  assert.deepEqual(unknown.progress(), { kind: 'failed', failure: 'notFound' });

  for (const error of ['Server type "stdio" does not support OAuth authentication', 'Server not found: other', 'blocked by managed policy']) {
    const refused = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
    refused.observe(initialized, 0);
    refused.step(0);
    refused.observe(refusal(claudeMcpAuthenticateRequestId(1), error), 1);
    assert.deepEqual(refused.progress(), { kind: 'failed', failure: 'unsupported' }, error);
  }
});

test('a Claude login that has not started within the start bound fails with a timeout', () => {
  const silent = new ClaudeMcpLogin('docs', 'signIn', 1_000, TIMING);
  assert.deepEqual(silent.step(25_999), []);
  assert.deepEqual(silent.progress(), { kind: 'starting' });
  assert.deepEqual(silent.step(26_000), []);
  assert.deepEqual(silent.progress(), { kind: 'failed', failure: 'timeout' });
  silent.observe(initialized, 26_001);
  assert.deepEqual(silent.progress(), { kind: 'failed', failure: 'timeout' });

  const stuck = new ClaudeMcpLogin('docs', 'signIn', 0, TIMING);
  stuck.observe(initialized, 0);
  stuck.step(0);
  stuck.step(25_000);
  assert.deepEqual(stuck.progress(), { kind: 'failed', failure: 'timeout' });

  const started = claudeAwaiting();
  started.step(10 * 60_000);
  assert.equal(started.progress().kind, 'awaitingCallback');
});

test('a pending Claude login polls the status every 1.5 seconds until the server is connected', () => {
  const login = claudeAwaiting();
  assert.deepEqual(login.step(20), []);
  assert.deepEqual(login.step(1_519), []);
  assert.deepEqual(login.step(1_520), [control(claudeMcpLoginStatusRequestId(1), { subtype: 'mcp_status' })]);
  assert.deepEqual(login.step(9_000), []);
  login.observe(success(claudeMcpLoginStatusRequestId(1), statusOf('docs', 'needs-auth')), 1_600);
  assert.deepEqual(login.step(3_019), []);
  assert.deepEqual(login.step(3_020), [control(claudeMcpLoginStatusRequestId(2), { subtype: 'mcp_status' })]);
  login.observe(success(claudeMcpLoginStatusRequestId(2), statusOf('docs', 'failed')), 3_100);
  login.observe(refusal(claudeMcpLoginStatusRequestId(2), 'late'), 3_100);
  assert.equal(login.progress().kind, 'awaitingCallback');
  assert.equal(login.step(4_520).length, 1);
  for (const response of [null, {}, { mcpServers: 'none' }, { mcpServers: [null, 'docs', { name: 'other', status: 'connected' }] }, statusOf('docs', 'pending')]) {
    login.observe(success(claudeMcpLoginStatusRequestId(3), response), 4_600);
    assert.equal(login.progress().kind, 'awaitingCallback', JSON.stringify(response));
  }
  assert.equal(login.step(6_020).length, 1);
  login.observe(refusal(claudeMcpLoginStatusRequestId(4), 'busy'), 6_100);
  assert.equal(login.progress().kind, 'awaitingCallback');
  assert.equal(login.step(7_520).length, 1);
  login.observe(success(claudeMcpLoginStatusRequestId(5), statusOf('docs', 'connected')), 7_600);
  assert.deepEqual(login.progress(), { kind: 'succeeded' });
  assert.deepEqual(login.step(20_000), []);
  assert.equal(login.submitCallback(CALLBACK_URL), false);
});

test('a pasted callback is submitted once through mcp_oauth_callback_url and a failed status afterwards fails the login', () => {
  const login = claudeAwaiting('claude.ai Gmail');
  assert.equal(login.callback(), 'idle');
  assert.equal(login.step(1_520).length, 1);
  assert.equal(login.submitCallback(CALLBACK_URL), true);
  assert.equal(login.submitCallback(CALLBACK_URL), false);
  assert.equal(login.callback(), 'pending');
  assert.deepEqual(login.step(1_600), [control(claudeMcpCallbackRequestId(1), { subtype: 'mcp_oauth_callback_url', serverName: 'claude.ai Gmail', callbackUrl: CALLBACK_URL })]);
  assert.deepEqual(login.step(1_700), []);
  login.observe(refusal(claudeMcpCallbackRequestId(1), 'Callback URL not accepted: it belongs to a different sign-in attempt'), 1_800);
  assert.equal(login.callback(), 'rejected');
  login.observe(success(claudeMcpLoginStatusRequestId(1), statusOf('claude.ai Gmail', 'failed')), 1_900);
  assert.equal(login.progress().kind, 'awaitingCallback');

  assert.equal(login.submitCallback(CALLBACK_URL), true);
  assert.equal(login.callback(), 'pending');
  const requests = login.step(3_020);
  assert.deepEqual(requests, [control(claudeMcpCallbackRequestId(2), { subtype: 'mcp_oauth_callback_url', serverName: 'claude.ai Gmail', callbackUrl: CALLBACK_URL }),
    control(claudeMcpLoginStatusRequestId(2), { subtype: 'mcp_status' })]);
  login.observe(success(claudeMcpCallbackRequestId(2)), 3_100);
  assert.equal(login.callback(), 'accepted');
  login.observe(success(claudeMcpLoginStatusRequestId(2), statusOf('claude.ai Gmail', 'failed')), 3_200);
  assert.equal(login.progress().kind, 'awaitingCallback');
  assert.equal(login.step(4_520).length, 1);
  login.observe(success(claudeMcpLoginStatusRequestId(3), statusOf('claude.ai Gmail', 'failed')), 4_600);
  assert.deepEqual(login.progress(), { kind: 'failed', failure: 'request' });

  const connected = claudeAwaiting();
  connected.submitCallback(CALLBACK_URL);
  connected.step(100);
  connected.observe(success(claudeMcpCallbackRequestId(1)), 200);
  connected.step(1_520);
  connected.observe(success(claudeMcpLoginStatusRequestId(1), statusOf('docs', 'connected')), 1_600);
  assert.deepEqual(connected.progress(), { kind: 'succeeded' });
  assert.equal(new ClaudeMcpLogin('docs', 'signIn', 0, TIMING).submitCallback(CALLBACK_URL), false);
});

test('Codex add reads the configuration, refuses an existing name and writes one replace edit', () => {
  const add = new CodexMcpAdd({ kind: 'add', name: 'docs-1', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, '/srv/project');
  assert.deepEqual(add.step(), { kind: 'wait' });
  add.observe(JSON.stringify({ method: 'remoteControl/status/changed', params: {}, id: 0 }));
  add.observe(JSON.stringify({ id: 1, result: { config: { mcp_servers: {} } } }));
  assert.deepEqual(add.step(), { kind: 'wait' });
  add.observe(codexReady);
  assert.deepEqual(add.step(), { kind: 'write', requests: [initializedNotification, { id: 1, method: 'config/read', params: { cwd: '/srv/project', includeLayers: false } }] });
  assert.deepEqual(add.step(), { kind: 'wait' });
  add.observe(JSON.stringify({ id: 1, result: { config: { mcp_servers: { other: { url: 'https://other.example.com' }, 'docs-10': {} } }, origins: {} } }));
  assert.deepEqual(add.step(), { kind: 'write', requests: [{ id: 2, method: 'config/batchWrite',
    params: { edits: [{ keyPath: 'mcp_servers.docs-1', mergeStrategy: 'replace', value: { url: 'https://mcp.example.com/mcp' } }] } }] });
  assert.deepEqual(add.step(), { kind: 'wait' });
  add.observe(JSON.stringify({ id: 2, result: { status: 'ok', version: 'sha256:1', filePath: '/home/user/.codex/config.toml', overriddenMetadata: null } }));
  assert.deepEqual(add.step(), { kind: 'done' });

  const stdio = new CodexMcpAdd({ kind: 'add', name: 'tool', scope: 'user', launch: { kind: 'stdio', command: '--weird', args: ['--a b', '--', 'c"d'] } }, '/srv/project');
  stdio.observe(codexReady);
  stdio.step();
  stdio.observe(JSON.stringify({ id: 1, result: { config: { mcp_servers: {} } } }));
  assert.deepEqual(stdio.step(), { kind: 'write', requests: [{ id: 2, method: 'config/batchWrite',
    params: { edits: [{ keyPath: 'mcp_servers.tool', mergeStrategy: 'replace', value: { command: '--weird', args: ['--a b', '--', 'c"d'] } }] } }] });
  stdio.observe(JSON.stringify({ id: 2, result: { status: 'okOverridden' } }));
  assert.deepEqual(stdio.step(), { kind: 'done' });
});

test('Codex add fails closed on an existing name, an unreadable configuration and a refused write', () => {
  const outcome = (config: unknown, write?: unknown) => {
    const add = new CodexMcpAdd({ kind: 'add', name: 'docs', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, '/srv/project');
    add.observe(codexReady);
    add.step();
    add.observe(JSON.stringify(config));
    const written = add.step();
    if (write === undefined || written.kind !== 'write') return written;
    add.observe(JSON.stringify(write));
    return add.step();
  };
  assert.deepEqual(outcome({ id: 1, result: { config: { mcp_servers: { docs: { url: 'https://old.example.com' } } } } }), { kind: 'failed', failure: 'exists' });
  assert.deepEqual(outcome({ id: 1, result: { config: { mcp_servers: { docs: null } } } }), { kind: 'failed', failure: 'exists' });
  assert.deepEqual(outcome({ id: 1, error: { code: -32603, message: 'boom' } }), { kind: 'failed', failure: 'request' });
  for (const result of [null, {}, { config: null }, { config: {} }, { config: { mcp_servers: null } }, { config: { mcp_servers: [] } }, { config: { mcp_servers: 'docs' } }])
    assert.deepEqual(outcome({ id: 1, result }), { kind: 'failed', failure: 'payload' }, JSON.stringify(result));
  const absent = { id: 1, result: { config: { mcp_servers: { toString: {}, other: {} } } } };
  assert.deepEqual(outcome(absent, { id: 2, error: { code: -32600, message: 'invalid key' } }), { kind: 'failed', failure: 'request' });
  for (const result of [null, {}, { status: 'failed' }, { status: 1 }]) assert.deepEqual(outcome(absent, { id: 2, result }), { kind: 'failed', failure: 'payload' }, JSON.stringify(result));
  assert.deepEqual(outcome(absent, { id: 2, result: { status: 'ok' } }), { kind: 'done' });

  const refused = new CodexMcpAdd({ kind: 'add', name: 'docs', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } }, '/srv/project');
  refused.observe(JSON.stringify({ id: 0, error: { code: -32600, message: 'refused' } }));
  assert.deepEqual(refused.step(), { kind: 'failed', failure: 'handshake' });
});

test('Codex login requests a 300 second OAuth login and waits for its completion notification', () => {
  const login = new CodexMcpLogin('docs', 0, TIMING);
  assert.deepEqual([login.step(0), login.progress()], [[], { kind: 'starting' }]);
  login.observe(JSON.stringify({ method: 'mcpServer/oauthLogin/completed', params: { name: 'docs', success: true, loginId: 'L1' } }));
  login.observe(codexReady);
  assert.deepEqual(login.step(10), [initializedNotification, { id: 1, method: 'mcpServer/oauth/login', params: { name: 'docs', timeoutSecs: 300 } }]);
  assert.deepEqual([login.step(20), login.progress()], [[], { kind: 'starting' }]);
  login.observe(JSON.stringify({ id: 1, result: { authorizationUrl: AUTH_URL, loginId: 'L1' } }));
  assert.deepEqual(login.progress(), { kind: 'awaitingCallback', authorizationUrl: AUTH_URL });
  assert.deepEqual(login.step(10 * 60_000), []);
  for (const params of [{ name: 'other', success: true, loginId: 'L1' }, { name: 'docs', success: true, loginId: 'L0' }, { success: true, loginId: 'L1' }, null]) {
    login.observe(JSON.stringify({ method: 'mcpServer/oauthLogin/completed', params }));
    assert.equal(login.progress().kind, 'awaitingCallback', JSON.stringify(params));
  }
  login.observe(JSON.stringify({ method: 'mcpServer/startupStatus/updated', params: { name: 'docs', success: true } }));
  assert.equal(login.progress().kind, 'awaitingCallback');
  login.observe(JSON.stringify({ method: 'mcpServer/oauthLogin/completed', params: { name: 'docs', threadId: null, loginId: 'L1', success: true, error: null } }));
  assert.deepEqual(login.progress(), { kind: 'succeeded' });
  login.observe(JSON.stringify({ method: 'mcpServer/oauthLogin/completed', params: { name: 'docs', loginId: 'L1', success: false } }));
  assert.deepEqual(login.progress(), { kind: 'succeeded' });

  const completions: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [{ authorizationUrl: AUTH_URL, loginId: 'L1' }, { name: 'docs', loginId: 'L1', success: false, error: 'timed out waiting for OAuth callback' }, 'failed'],
    [{ authorizationUrl: AUTH_URL, loginId: 'L1' }, { name: 'docs', success: true }, 'succeeded'],
    [{ authorizationUrl: AUTH_URL, loginId: 'L1' }, { name: 'docs', loginId: null, success: true }, 'succeeded'],
    [{ authorizationUrl: AUTH_URL }, { name: 'docs', loginId: 'L9', success: true }, 'succeeded'],
    [{ authorizationUrl: AUTH_URL, loginId: null }, { name: 'docs', success: 'true' }, 'failed'],
  ];
  for (const [result, params, expected] of completions) {
    const other = new CodexMcpLogin('docs', 0, TIMING);
    other.observe(codexReady);
    other.step(1);
    other.observe(JSON.stringify({ id: 1, result }));
    other.observe(JSON.stringify({ method: 'mcpServer/oauthLogin/completed', params }));
    assert.equal(other.progress().kind, expected, JSON.stringify(params));
  }
});

test('Codex login maps an unknown server, an unsupported server, an unusable answer and a silent provider', () => {
  const answered = (message: unknown) => {
    const login = new CodexMcpLogin('docs', 0, TIMING);
    login.observe(codexReady);
    login.step(1);
    login.observe(JSON.stringify(message));
    return login.progress();
  };
  assert.deepEqual(answered({ id: 1, error: { code: -32600, message: "No MCP server named 'docs' found." } }), { kind: 'failed', failure: 'notFound' });
  for (const message of ["No MCP server named 'other' found.", 'OAuth login is only supported for streamable HTTP servers.', "failed to login to MCP server 'docs': Metadata error"])
    assert.deepEqual(answered({ id: 1, error: { code: -32603, message } }), { kind: 'failed', failure: 'unsupported' }, message);
  assert.deepEqual(answered({ id: 1, error: null }), { kind: 'failed', failure: 'unsupported' });
  for (const result of [null, {}, { authorizationUrl: 'http://evil.example.com/authorize' }, { authorizationUrl: 7 }, { authorizationUrl: 'https://auth.example.com/a b' }])
    assert.deepEqual(answered({ id: 1, result }), { kind: 'failed', failure: 'payload' }, JSON.stringify(result));

  const refused = new CodexMcpLogin('docs', 0, TIMING);
  refused.observe(JSON.stringify({ id: 0, error: { code: -32600, message: 'refused' } }));
  assert.deepEqual(refused.progress(), { kind: 'failed', failure: 'handshake' });

  const silent = new CodexMcpLogin('docs', 500, TIMING);
  assert.deepEqual([silent.step(25_499), silent.progress()], [[], { kind: 'starting' }]);
  silent.step(25_500);
  assert.deepEqual(silent.progress(), { kind: 'failed', failure: 'timeout' });

  const slow = new CodexMcpLogin('docs', 0, TIMING);
  slow.observe(codexReady);
  assert.deepEqual(slow.step(25_000), []);
  assert.deepEqual(slow.progress(), { kind: 'failed', failure: 'timeout' });
});
