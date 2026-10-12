import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_CONFIGURABLE_SERVER_NAME_PATTERN, MCP_SERVER_CONFIG_SCOPES, MCP_SERVER_LOGIN_ID_PATTERN, MCP_SERVER_LOGIN_MODES, MCP_SERVER_LOGIN_STATES,
  MCP_SERVER_MANAGEMENT_CAPABILITY, MCP_SERVER_MANAGEMENT_ERRORS, MCP_SERVER_MANAGEMENT_LIMITS, isMcpServerChangeSupported, isMcpServerLoginId,
  isMcpServerManagementError, isValidMcpAuthorizationUrl, isValidMcpCallbackUrl, isValidMcpLaunchUrl, mcpLoopbackCallbackPath, mcpLoopbackRedirect,
  parseMcpServerChangeRequest, parseMcpServerLoginCallback, parseMcpServerLoginRequest, type McpServerChange,
} from '../src/domain/mcp-server-management.js';
import { claudeMcpAddPlan, claudeMcpRemovePlan, codexMcpLogoutPlan, codexMcpRemovePlan } from '../src/domain/mcp-server-management-cli.js';

const invalid = { name: 'RunnerError', code: 'invalid_input' };
const http = { kind: 'http', url: 'https://mcp.example.com/mcp' };
const stdio = { kind: 'stdio', command: 'npx', args: ['-y', 'server'] };
const add = (changed: Readonly<Record<string, unknown>> = {}) => ({ change: { kind: 'add', name: 'docs', scope: 'user', launch: http, ...changed } });
const remove = (changed: Readonly<Record<string, unknown>> = {}) => ({ change: { kind: 'remove', name: 'docs', scope: 'user', ...changed } });
const signOut = (changed: Readonly<Record<string, unknown>> = {}) => ({ change: { kind: 'signOut', name: 'docs', ...changed } });
const rejectsChange = (value: unknown, label: string) => assert.throws(() => parseMcpServerChangeRequest(value), invalid, label);
const HOSTILE = ['--scope', '-e', 'EVIL=1', '--', '--help', '$(touch pwned)', '; rm -rf /', 'a b', '"quoted"', "it's", ''];

test('MCP server management constants equal the shared contract', () => {
  assert.equal(MCP_SERVER_MANAGEMENT_CAPABILITY, 'mcpServerManagement');
  assert.deepEqual([...MCP_SERVER_CONFIG_SCOPES], ['user', 'project', 'local']);
  assert.deepEqual([...MCP_SERVER_LOGIN_MODES], ['signIn', 'signInAgain']);
  assert.deepEqual([...MCP_SERVER_LOGIN_STATES], ['pending', 'succeeded', 'failed']);
  assert.deepEqual(MCP_SERVER_MANAGEMENT_LIMITS, { maxUrlBytes: 2048, maxCommandBytes: 1024, maxArgs: 32, maxArgBytes: 1024, maxAuthorizationUrlBytes: 4096, maxCallbackUrlBytes: 8192 });
  assert.equal(MCP_CONFIGURABLE_SERVER_NAME_PATTERN.source, '^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$');
  assert.equal(MCP_SERVER_LOGIN_ID_PATTERN.source, '^[A-Za-z0-9-]{8,64}$');
  assert.deepEqual([...MCP_SERVER_MANAGEMENT_ERRORS], ['mcp_server_exists', 'mcp_server_not_found', 'mcp_change_unsupported', 'mcp_login_unsupported', 'mcp_login_inactive', 'mcp_callback_rejected']);
  for (const code of MCP_SERVER_MANAGEMENT_ERRORS) assert.equal(isMcpServerManagementError(code), true, code);
  for (const code of ['busy', 'not_found', 'invalid_input', 'storage_unavailable', 'conflict'] as const) assert.equal(isMcpServerManagementError(code), false, code);
});

test('a change request is parsed into the closed model and every other shape is refused', () => {
  assert.deepEqual(parseMcpServerChangeRequest(add()), { kind: 'add', name: 'docs', scope: 'user', launch: http });
  assert.deepEqual(parseMcpServerChangeRequest(add({ scope: 'local', launch: { kind: 'sse', url: 'http://127.0.0.1:9/sse' } })),
    { kind: 'add', name: 'docs', scope: 'local', launch: { kind: 'sse', url: 'http://127.0.0.1:9/sse' } });
  assert.deepEqual(parseMcpServerChangeRequest(add({ scope: 'project', launch: stdio })), { kind: 'add', name: 'docs', scope: 'project', launch: stdio });
  assert.deepEqual(parseMcpServerChangeRequest(add({ launch: { kind: 'stdio', command: '--scope', args: HOSTILE } })).kind, 'add');
  assert.deepEqual(parseMcpServerChangeRequest(remove({ scope: 'project' })), { kind: 'remove', name: 'docs', scope: 'project' });
  assert.deepEqual(parseMcpServerChangeRequest(signOut({ name: 'claude.ai Gmail' })), { kind: 'signOut', name: 'claude.ai Gmail' });
  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null], ['array', [add()]], ['string', 'add'], ['empty', {}], ['bare change', add().change], ['extra envelope field', { ...add(), cwd: '/tmp' }],
    ['null change', { change: null }], ['array change', { change: [] }], ['unknown kind', { change: { kind: 'rename', name: 'docs' } }], ['missing kind', { change: { name: 'docs' } }],
    ['add extra field', add({ env: {} })], ['add without launch', { change: { kind: 'add', name: 'docs', scope: 'user' } }], ['add without scope', { change: { kind: 'add', name: 'docs', launch: http } }],
    ['unknown scope', add({ scope: 'managed' })], ['scope type', add({ scope: 1 })], ['remove extra field', remove({ launch: http })], ['remove without scope', { change: { kind: 'remove', name: 'docs' } }],
    ['remove unknown scope', remove({ scope: 'account' })], ['signOut with scope', signOut({ scope: 'user' })], ['signOut without name', { change: { kind: 'signOut' } }],
    ['launch null', add({ launch: null })], ['launch kind', add({ launch: { kind: 'websocket', url: http.url } })], ['launch extra field', add({ launch: { ...http, headers: {} } })],
    ['http with command', add({ launch: { kind: 'http', command: 'npx', args: [] } })], ['stdio with url', add({ launch: { ...stdio, url: http.url } })],
    ['stdio without args', add({ launch: { kind: 'stdio', command: 'npx' } })], ['stdio string args', add({ launch: { kind: 'stdio', command: 'npx', args: '-y' } })],
    ['prototype key', JSON.parse('{"change":{"kind":"signOut","name":"docs","__proto__":{}}}')],
  ];
  for (const [label, value] of shapes) rejectsChange(value, label);
});

test('configurable names never start with a dash and stay within 64 safe characters', () => {
  for (const name of ['a', '_private', 'Docs-2', '0', 'a'.repeat(64), 'under_score-dash']) {
    assert.equal(parseMcpServerChangeRequest(add({ name })).name, name, name);
    assert.equal(parseMcpServerChangeRequest(remove({ name })).name, name, name);
  }
  for (const name of ['', '-docs', '--scope', 'a'.repeat(65), 'has space', 'dot.name', 'slash/name', 'ünï', 'a\n', 'a\0', '$(x)', 'claude.ai Gmail', 1, null, ['docs']]) {
    rejectsChange(add({ name }), `add ${String(name)}`);
    rejectsChange(remove({ name }), `remove ${String(name)}`);
  }
});

test('sign-out and login names follow the status name rule', () => {
  for (const name of ['docs', 'claude.ai Gmail', '-dash', 'ünï', 'a'.repeat(128)]) {
    assert.equal(parseMcpServerChangeRequest(signOut({ name })).name, name, name);
    assert.deepEqual(parseMcpServerLoginRequest({ name, mode: 'signIn' }), { name, mode: 'signIn' }, name);
  }
  for (const name of ['', ' docs', 'docs ', 'a\nb', 'a\0b', 'a‮b', 'a'.repeat(129), 'é'.repeat(65), 7, null]) {
    rejectsChange(signOut({ name }), String(name));
    assert.throws(() => parseMcpServerLoginRequest({ name, mode: 'signIn' }), invalid, String(name));
  }
});

test('launch URLs are bounded http or https URLs without credentials, whitespace or control characters', () => {
  const longest = `https://mcp.example.com/${'a'.repeat(2048 - 'https://mcp.example.com/'.length)}`;
  for (const url of ['https://mcp.example.com/mcp', 'http://127.0.0.1:9/sse', 'https://mcp.example.com/mcp?x=--scope', 'https://[::1]:8443/mcp', 'HTTPS://mcp.example.com/mcp', longest]) {
    assert.equal(isValidMcpLaunchUrl(url), true, url);
    assert.deepEqual(parseMcpServerChangeRequest(add({ launch: { kind: 'http', url } })).kind, 'add', url);
  }
  for (const url of [`${longest}a`, 'ftp://mcp.example.com/mcp', 'file:///etc/passwd', 'mcp.example.com/mcp', '--scope', '-https://x', 'https://user@mcp.example.com/mcp',
    'https://user:secret@mcp.example.com/mcp', 'https://mcp.example.com/a b', ' https://mcp.example.com/mcp', 'https://mcp.example.com/mcp\n', 'https://mcp.example.com/\0',
    'https:\\\\mcp.example.com', 'https:/mcp.example.com', 'https://', `https://mcp.example.com/${'é'.repeat(1100)}`, '', 7, null]) {
    assert.equal(isValidMcpLaunchUrl(url), false, String(url));
    rejectsChange(add({ launch: { kind: 'http', url } }), String(url));
    rejectsChange(add({ launch: { kind: 'sse', url } }), String(url));
  }
});

test('stdio commands and arguments are bounded argv values without control characters', () => {
  const launch = (command: unknown, args: unknown) => add({ launch: { kind: 'stdio', command, args } });
  assert.deepEqual(parseMcpServerChangeRequest(launch('a'.repeat(1024), Array.from({ length: 32 }, () => 'b'.repeat(1024)))).kind, 'add');
  assert.deepEqual(parseMcpServerChangeRequest(launch('/opt/tool with space', [])).kind, 'add');
  for (const command of ['', 'a'.repeat(1025), 'é'.repeat(513), 'a\0', 'a\nb', 'a\tb', 'a\u007fb', 7, null, ['npx']]) rejectsChange(launch(command, []), `command ${String(command)}`);
  for (const args of [Array.from({ length: 33 }, () => 'a'), ['a'.repeat(1025)], ['é'.repeat(513)], ['a\0'], ['a\nb'], ['ok', 7], [null], [['nested']], 'a', null, { 0: 'a' }])
    rejectsChange(launch('npx', args), `args ${JSON.stringify(args)}`);
});

test('provider, scope and transport combinations a provider cannot perform are unsupported', () => {
  const change = (value: unknown) => parseMcpServerChangeRequest(value);
  const supported: ReadonlyArray<readonly ['claude' | 'codex', McpServerChange]> = [
    ['claude', change(add())], ['claude', change(add({ scope: 'local' }))], ['claude', change(add({ scope: 'local', launch: { kind: 'sse', url: http.url } }))],
    ['claude', change(add({ launch: stdio }))], ['claude', change(remove())], ['claude', change(remove({ scope: 'local' }))], ['claude', change(remove({ scope: 'project' }))],
    ['claude', change(signOut())], ['codex', change(add())], ['codex', change(add({ launch: stdio }))], ['codex', change(remove())], ['codex', change(signOut())],
  ];
  for (const [provider, value] of supported) assert.equal(isMcpServerChangeSupported(provider, value), true, `${provider} ${JSON.stringify(value)}`);
  const unsupported: ReadonlyArray<readonly ['claude' | 'codex', McpServerChange]> = [
    ['claude', change(add({ scope: 'project' }))], ['claude', change(add({ scope: 'project', launch: stdio }))],
    ['codex', change(add({ scope: 'local' }))], ['codex', change(add({ scope: 'project' }))], ['codex', change(add({ launch: { kind: 'sse', url: http.url } }))],
    ['codex', change(remove({ scope: 'local' }))], ['codex', change(remove({ scope: 'project' }))],
  ];
  for (const [provider, value] of unsupported) assert.equal(isMcpServerChangeSupported(provider, value), false, `${provider} ${JSON.stringify(value)}`);
});

test('login requests carry exactly a name and a closed mode', () => {
  assert.deepEqual(parseMcpServerLoginRequest({ name: 'docs', mode: 'signInAgain' }), { name: 'docs', mode: 'signInAgain' });
  for (const value of [null, [], 'docs', {}, { name: 'docs' }, { mode: 'signIn' }, { name: 'docs', mode: 'signOut' }, { name: 'docs', mode: 'SIGNIN' }, { name: 'docs', mode: 1 },
    { name: 'docs', mode: 'signIn', scope: 'user' }, { name: 'docs', mode: 'signIn', callbackUrl: 'http://localhost/callback?code=1' }])
    assert.throws(() => parseMcpServerLoginRequest(value), invalid, JSON.stringify(value));
});

test('authorization URLs are https, or http only towards the loopback host', () => {
  const longest = `https://auth.example.com/${'a'.repeat(4096 - 'https://auth.example.com/'.length)}`;
  for (const url of ['https://auth.example.com/authorize?state=1', 'http://localhost:4000/authorize', 'http://127.0.0.1/authorize', longest]) assert.equal(isValidMcpAuthorizationUrl(url), true, url);
  for (const url of [`${longest}a`, 'http://auth.example.com/authorize', 'http://127.0.0.2/authorize', 'http://localhost.example.com/authorize', 'http://[::1]/authorize',
    'HTTPS://auth.example.com/authorize', 'Http://localhost:4000/authorize', 'https://user@auth.example.com/authorize', 'https://user:secret@auth.example.com/authorize',
    'http://user@localhost:4000/authorize', 'javascript:alert(1)', 'file:///etc/passwd', 'https://auth.example.com/a b', 'https://auth.example.com/\n', 'https:\\\\auth.example.com', 'auth.example.com', '', null, 7, {}])
    assert.equal(isValidMcpAuthorizationUrl(url), false, String(url));
});

test('login ids are opaque bounded tokens', () => {
  for (const id of ['12345678', 'a'.repeat(64), '0b9f3c1e-7d2a-4f65-9c11-2d8f4a6b7c90', 'ABC-def-123']) assert.equal(isMcpServerLoginId(id), true, id);
  for (const id of ['1234567', 'a'.repeat(65), 'has space', 'under_score', 'slash/1234567', '../../etc', '', null, 12345678]) assert.equal(isMcpServerLoginId(id), false, String(id));
});

test('callback URLs are bounded loopback http URLs carrying a code or an error', () => {
  const longest = `http://localhost:4000/callback?code=${'a'.repeat(8192 - 'http://localhost:4000/callback?code='.length)}`;
  for (const url of ['http://localhost:4000/callback?code=1&state=2', 'http://127.0.0.1:4000/callback?error=access_denied', 'http://localhost/callback?state=2&code=1', longest]) {
    assert.equal(isValidMcpCallbackUrl(url), true, url);
    assert.equal(parseMcpServerLoginCallback({ callbackUrl: url }), url);
  }
  for (const url of [`${longest}a`, 'https://localhost:4000/callback?code=1', 'http://example.com/callback?code=1', 'http://127.0.0.2:4000/callback?code=1', 'http://[::1]:4000/callback?code=1',
    'http://localhost:4000/callback', 'http://localhost:4000/callback?state=2', 'http://localhost:4000/callback#code=1', 'localhost:4000/callback?code=1', 'not a url', '', null, 7]) {
    assert.equal(isValidMcpCallbackUrl(url), false, String(url));
    assert.throws(() => parseMcpServerLoginCallback({ callbackUrl: url }), invalid, String(url));
  }
  for (const value of [null, [], 'http://localhost/callback?code=1', {}, { callbackUrl: 'http://localhost/callback?code=1', loginId: 'x' }, { url: 'http://localhost/callback?code=1' }])
    assert.throws(() => parseMcpServerLoginCallback(value), invalid, JSON.stringify(value));
});

test('a pasted callback is forwarded only to the port and path of the redirect the session itself received', () => {
  const authorization = (redirect: string) => `https://auth.example.com/authorize?state=1&redirect_uri=${encodeURIComponent(redirect)}`;
  const redirect = mcpLoopbackRedirect(authorization('http://127.0.0.1:38205/callback'));
  assert.deepEqual(redirect, { port: 38205, path: '/callback' });
  assert.deepEqual(mcpLoopbackRedirect(authorization('http://localhost:4000/oauth/cb')), { port: 4000, path: '/oauth/cb' });
  assert.deepEqual(mcpLoopbackRedirect(authorization('http://localhost/cb')), { port: 80, path: '/cb' });
  for (const value of [authorization('https://127.0.0.1:38205/callback'), authorization('http://example.com:38205/callback'), authorization('http://user@127.0.0.1:1/callback'),
    authorization('not a url'), 'https://auth.example.com/authorize?state=1', 'not a url', ''])
    assert.equal(mcpLoopbackRedirect(value), null, value);
  assert.ok(redirect);
  assert.equal(mcpLoopbackCallbackPath(redirect, 'http://127.0.0.1:38205/callback?code=a%20b&state=c%26d'), '/callback?code=a%20b&state=c%26d');
  assert.equal(mcpLoopbackCallbackPath(redirect, 'http://localhost:38205/callback?error=access_denied#fragment'), '/callback?error=access_denied');
  for (const callback of ['http://127.0.0.1:38206/callback?code=1', 'http://127.0.0.1/callback?code=1', 'http://127.0.0.1:38205/other?code=1', 'http://127.0.0.1:38205/callback/../admin?code=1',
    'http://127.0.0.1:38205//callback?code=1', 'http://example.com:38205/callback?code=1', 'https://127.0.0.1:38205/callback?code=1', 'not a url'])
    assert.equal(mcpLoopbackCallbackPath(redirect, callback), null, callback);
  assert.equal(mcpLoopbackCallbackPath({ port: 80, path: '/cb' }, 'http://localhost/cb?code=1'), '/cb?code=1');
});

test('Claude add and remove put every user value behind the option terminator', () => {
  const hostile = parseMcpServerChangeRequest(add({ name: '_x-1', scope: 'local', launch: { kind: 'stdio', command: '--scope', args: HOSTILE } }));
  assert.equal(hostile.kind, 'add');
  if (hostile.kind === 'add') assert.deepEqual(claudeMcpAddPlan(hostile).args, ['mcp', 'add', '--scope', 'local', '--transport', 'stdio', '--', '_x-1', '--scope', ...HOSTILE]);
  assert.deepEqual(claudeMcpAddPlan({ kind: 'add', name: 'web', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp?x=--scope' } }).args,
    ['mcp', 'add', '--scope', 'user', '--transport', 'http', '--', 'web', 'https://mcp.example.com/mcp?x=--scope']);
  assert.deepEqual(claudeMcpAddPlan({ kind: 'add', name: 'events', scope: 'local', launch: { kind: 'sse', url: 'http://127.0.0.1:9/sse' } }).args,
    ['mcp', 'add', '--scope', 'local', '--transport', 'sse', '--', 'events', 'http://127.0.0.1:9/sse']);
  assert.deepEqual(claudeMcpRemovePlan({ kind: 'remove', name: 'web', scope: 'project' }).args, ['mcp', 'remove', '--scope', 'project', '--', 'web']);
  assert.deepEqual(codexMcpRemovePlan('web').args, ['mcp', 'remove', '--', 'web']);
  assert.deepEqual(codexMcpLogoutPlan('--help').args, ['mcp', 'logout', '--', '--help']);
  for (const plan of [claudeMcpAddPlan({ kind: 'add', name: 'web', scope: 'user', launch: { kind: 'stdio', command: '-x', args: ['--', '-y'] } }),
    claudeMcpRemovePlan({ kind: 'remove', name: 'web', scope: 'user' }), codexMcpRemovePlan('web'), codexMcpLogoutPlan('-web')]) {
    const terminator = plan.args.indexOf('--');
    assert.ok(terminator > 0);
    assert.deepEqual(plan.args.slice(0, terminator).filter(arg => !['mcp', 'add', 'remove', 'logout', '--scope', 'user', '--transport', 'stdio'].includes(arg)), []);
  }
});

test('CLI outcomes are classified from the exit status and one narrow line', () => {
  const claudeAdd = claudeMcpAddPlan({ kind: 'add', name: 'web', scope: 'user', launch: http as { kind: 'http'; url: string } });
  assert.equal(claudeAdd.outcome(0, 'Added HTTP MCP server web\n'), 'ok');
  assert.equal(claudeAdd.outcome(0, 'MCP server web already exists in user config\n'), 'ok');
  assert.equal(claudeAdd.outcome(1, 'warning\nMCP server web already exists in user config\n'), 'exists');
  assert.equal(claudeAdd.outcome(1, 'warning\r\nMCP server web already exists in local config\r\n'), 'exists');
  for (const [code, output] of [[1, 'MCP server other already exists in user config'], [1, 'x MCP server web already exists in user config'], [1, ''], [2, 'MCP server web already exists in user config'],
    [null, 'MCP server web already exists in user config'], [125, 'workspace_identity_changed']] as const) assert.equal(claudeAdd.outcome(code, output), 'failed', `${code} ${output}`);

  const claudeRemove = claudeMcpRemovePlan({ kind: 'remove', name: 'web', scope: 'project' });
  assert.equal(claudeRemove.outcome(0, 'Removed MCP server web from project config'), 'ok');
  assert.equal(claudeRemove.outcome(1, 'No MCP server named "web" in .mcp.json'), 'notFound');
  assert.equal(claudeRemove.outcome(1, '\nNo MCP server named "web" in user scope\n'), 'notFound');
  for (const [code, output] of [[1, 'No MCP server named "other" in user scope'], [1, 'No MCP server named "web2" in user scope'], [1, 'failed'], [2, 'No MCP server named "web" in user scope'], [null, '']] as const)
    assert.equal(claudeRemove.outcome(code, output), 'failed', `${code} ${output}`);

  const codexRemove = codexMcpRemovePlan('web');
  assert.equal(codexRemove.outcome(0, "WARNING: aliases\nRemoved global MCP server 'web'.\n"), 'ok');
  assert.equal(codexRemove.outcome(0, "No MCP server named 'web' found.\n"), 'notFound');
  assert.equal(codexRemove.outcome(0, "No MCP server named 'other' found.\n"), 'ok');
  for (const code of [1, 2, null]) assert.equal(codexRemove.outcome(code, "No MCP server named 'web' found."), 'failed', String(code));

  const codexLogout = codexMcpLogoutPlan('web');
  assert.equal(codexLogout.outcome(0, "No OAuth credentials stored for 'web'."), 'ok');
  assert.equal(codexLogout.outcome(0, "Removed OAuth credentials for 'web'."), 'ok');
  assert.equal(codexLogout.outcome(1, "Error: No MCP server named 'web' found in configuration."), 'notFound');
  assert.equal(codexLogout.outcome(1, 'Error: OAuth logout is only supported for streamable_http transports.'), 'unsupported');
  for (const [code, output] of [[1, "Error: No MCP server named 'other' found in configuration."], [1, 'Error: keyring unavailable'], [2, "Error: No MCP server named 'web' found in configuration."], [null, '']] as const)
    assert.equal(codexLogout.outcome(code, output), 'failed', `${code} ${output}`);
});
