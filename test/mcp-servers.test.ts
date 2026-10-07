import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MCP_ENDPOINT_ORIGIN_PATTERN, MCP_SERVERS_CAPABILITY, MCP_SERVERS_LIMITS, MCP_SERVER_SCOPES, MCP_SERVER_STATUSES, MCP_SERVER_TRANSPORTS,
  endpointOrigin, isMcpServersProvider, isValidEndpointOrigin, isValidMcpServerName, markCodexDisabledMcpServers, parseClaudeMcpServers,
  parseCodexMcpServers, sanitizeMcpFailureDetail, validateMcpServers, type McpServer, type McpServers,
} from '../src/domain/mcp-servers.js';

type Example = Readonly<{ name: string; value: Readonly<Record<string, unknown>> }>;
type Fixture = Readonly<{
  schemaVersion: number; remoteRunnerCapability: string; remoteRunnerRoute: string; remoteRunnerProviders: Readonly<Record<string, string>>;
  limits: Readonly<Record<string, number | string>>; statuses: readonly string[]; scopes: readonly string[]; transports: readonly string[];
  responses: readonly Example[]; rejectedResponses: readonly Example[];
  remoteRunnerResponses: readonly Example[]; rejectedRemoteRunnerResponses: readonly Example[];
}>;
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/agent-mcp-servers-wire.json', import.meta.url), 'utf8')) as Fixture;

const MARKER = 'MARKER_SECRET';
const rejected = { message: 'invalid_mcp_servers' };
const claude = (servers: readonly unknown[]) => parseClaudeMcpServers({ mcpServers: servers });
const codex = (data: readonly unknown[]) => parseCodexMcpServers({ data, nextCursor: null });
const codexEntry = (name: string, changed: Readonly<Record<string, unknown>> = {}) => ({
  name, runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, tools: {}, toolsError: null,
  resources: [], resourceTemplates: [], authStatus: 'unsupported', ...changed,
});
const names = (snapshot: McpServers) => snapshot.servers.map(server => server.name);
function server(snapshot: McpServers, name: string): McpServer {
  const found = snapshot.servers.find(candidate => candidate.name === name);
  assert.ok(found, name);
  return found;
}
const wire = (changed: Readonly<Record<string, unknown>> = {}, provider = 'codex') => ({ version: 1, provider, truncated: false,
  servers: [{ name: 'docs', status: 'connected', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null, ...changed }] });
const asRunner = (example: Example) => ({ ...example.value, provider: fixture.remoteRunnerProviders[String(example.value.provider)] ?? example.value.provider });
const claudeDetail = (error: unknown, status = 'failed') => claude([{ name: 'docs', status, error }]).servers[0]!.detail;
const codexDetail = (toolsError: unknown) => codex([codexEntry('docs', { toolsError })]).servers[0]!.detail;

test('MCP server constants equal the editor contract', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.remoteRunnerCapability, MCP_SERVERS_CAPABILITY);
  assert.equal(fixture.remoteRunnerRoute, '/v1/projects/{projectId}/mcp-servers/{claude|codex}');
  assert.deepEqual(fixture.remoteRunnerProviders, { claudeCode: 'claude', codex: 'codex' });
  assert.deepEqual(Object.values(fixture.remoteRunnerProviders).filter(isMcpServersProvider), ['claude', 'codex']);
  for (const provider of ['claudeCode', 'gemini', '', null, 1]) assert.equal(isMcpServersProvider(provider), false, String(provider));
  assert.deepEqual(fixture.statuses, [...MCP_SERVER_STATUSES]);
  assert.deepEqual(fixture.scopes, [...MCP_SERVER_SCOPES]);
  assert.deepEqual(fixture.transports, [...MCP_SERVER_TRANSPORTS]);
  const { endpointOriginPattern, maxRepositoryRootBytes, ...shared } = fixture.limits;
  assert.deepEqual(shared, { ...MCP_SERVERS_LIMITS });
  assert.equal(maxRepositoryRootBytes, 4096);
  assert.equal(new RegExp(String(endpointOriginPattern)).source, MCP_ENDPOINT_ORIGIN_PATTERN.source);
});

test('the outbound validator accepts every runner response of the contract and rejects every rejected shape', () => {
  assert.ok(fixture.remoteRunnerResponses.length >= 2 && fixture.rejectedRemoteRunnerResponses.length >= 3);
  assert.ok(fixture.responses.length >= 4 && fixture.rejectedResponses.length >= 20);
  for (const example of fixture.remoteRunnerResponses) {
    assert.deepEqual(validateMcpServers(example.value), example.value, example.name);
    assert.deepEqual(JSON.parse(JSON.stringify(validateMcpServers(example.value))), example.value, example.name);
  }
  for (const example of fixture.rejectedRemoteRunnerResponses) assert.throws(() => validateMcpServers(example.value), rejected, example.name);
  for (const example of fixture.responses) assert.deepEqual(validateMcpServers(asRunner(example)), asRunner(example), example.name);
  const local = fixture.responses.filter(example => example.value.provider === 'claudeCode');
  assert.ok(local.length >= 2);
  for (const example of local) assert.throws(() => validateMcpServers(example.value), rejected, example.name);
  for (const example of fixture.rejectedResponses) assert.throws(() => validateMcpServers(asRunner(example)), rejected, example.name);
});

test('the outbound validator bounds names, counts, origins and details', () => {
  assert.doesNotThrow(() => validateMcpServers(wire({ name: 'n'.repeat(128), toolCount: 4096 })));
  assert.doesNotThrow(() => validateMcpServers(wire({ status: 'failed', detail: 'é'.repeat(128) })));
  assert.doesNotThrow(() => validateMcpServers(wire({ transport: 'unknown', endpointOrigin: 'http://[::1]:9000' })));
  assert.doesNotThrow(() => validateMcpServers({ ...wire(), servers: Array.from({ length: 128 }, (_, index) => ({ ...wire().servers[0], name: `s${index}` })) }));
  for (const changed of [{ name: 'n'.repeat(129) }, { name: 'é'.repeat(65) }, { name: 'do\u200ecs' }, { name: 'docs\u202e' }, { name: '\u2066docs' }, { name: 'docs\u007f' },
    { name: 'docs\u00a0' }, { name: 'lone\ud800' }, { name: 7 }, { status: 'pending' }, { scope: 'claudeai' }, { transport: 'ws' }, { toolCount: 4097 }, { toolCount: '1' },
    { status: 'failed', detail: 'é'.repeat(129) }, { status: 'failed', detail: ' padded' }, { status: 'failed', detail: 'padded ' }, { status: 'failed', detail: 7 },
    { status: 'failed', detail: 'next\u0085line' }, { transport: 'http', endpointOrigin: 'https://host:0' }, { transport: 'http', endpointOrigin: 7 },
    { transport: 'http', endpointOrigin: `https://${'a'.repeat(249)}` }, { detail: undefined }])
    assert.throws(() => validateMcpServers(wire(changed)), rejected, JSON.stringify(changed));
  assert.throws(() => validateMcpServers({ ...wire(), servers: Array.from({ length: 129 }, (_, index) => ({ ...wire().servers[0], name: `s${index}` })) }), rejected);
  for (const value of [null, [], 'servers', { ...wire(), servers: {} }, { ...wire(), truncated: 'no' }, { ...wire(), servers: [null] }, { ...wire(), servers: ['docs'] }])
    assert.throws(() => validateMcpServers(value), rejected);
});

test('Claude statuses, scopes and transports map to the closed wire enums', () => {
  const snapshot = claude([
    { name: 'claude.ai Claude Docs', status: 'connected', serverInfo: { name: 'Claude Docs', version: '0.1.0' }, config: { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_01' },
      scope: 'claudeai', source: 'claudeai', tools: [{ name: 'create' }, { name: 'read' }] },
    { name: 'claude.ai Gmail', status: 'needs-auth', config: { type: 'claudeai-proxy', url: 'https://gmailmcp.googleapis.com/mcp/v1', id: 'mcpsrv_01T' }, scope: 'claudeai', source: 'claudeai' },
    { name: 'slow-indexer', status: 'pending', config: { type: 'stdio', command: '/bin/sleep', args: ['8'] }, scope: 'local', source: 'local' },
    { name: 'broken-stdio', status: 'failed', error: 'Connection closed', config: { command: '/bin/false', args: [] }, scope: 'project', source: 'project' },
    { name: 'legacy-events', status: 'disabled', config: { type: 'sse', url: 'http://127.0.0.1:8931/sse' }, scope: 'user', source: 'user' },
    { name: 'policy', status: 'connected', config: { type: 'http', url: 'https://mcp.corp.example:8443/mcp' }, scope: 'managed', tools: [] },
    { name: 'enterprise', status: 'connected', config: { type: 'http', url: 'https://mcp.corp.example' }, scope: 'enterprise' },
    { name: 'ide', status: 'reconnecting', config: { type: 'ws-ide', url: 'ws://127.0.0.1:4000' }, scope: 'dynamic' },
    { name: 'typed-oddly', status: 7, config: { type: 3 }, scope: null },
    { name: 'prototype', status: 'constructor', config: { type: 'toString' }, scope: '__proto__' },
    { name: 'null-type', status: 'connected', config: { type: null, command: 'npx' }, scope: 'user' },
    { name: 'bare' },
  ]);
  assert.deepEqual([snapshot.version, snapshot.provider, snapshot.truncated], [1, 'claude', false]);
  assert.deepEqual(names(snapshot), ['bare', 'broken-stdio', 'claude.ai Claude Docs', 'claude.ai Gmail', 'enterprise', 'ide', 'legacy-events', 'null-type', 'policy',
    'prototype', 'slow-indexer', 'typed-oddly']);
  assert.deepEqual(server(snapshot, 'claude.ai Claude Docs'), { name: 'claude.ai Claude Docs', status: 'connected', scope: 'account', transport: 'http',
    endpointOrigin: 'https://api.anthropic.com', toolCount: 2, detail: null });
  assert.deepEqual(server(snapshot, 'claude.ai Gmail'), { name: 'claude.ai Gmail', status: 'needsAuth', scope: 'account', transport: 'http',
    endpointOrigin: 'https://gmailmcp.googleapis.com', toolCount: null, detail: null });
  assert.deepEqual(server(snapshot, 'slow-indexer'), { name: 'slow-indexer', status: 'connecting', scope: 'local', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null });
  assert.deepEqual(server(snapshot, 'broken-stdio'), { name: 'broken-stdio', status: 'failed', scope: 'project', transport: 'stdio', endpointOrigin: null, toolCount: null,
    detail: 'Connection closed' });
  assert.deepEqual(server(snapshot, 'legacy-events'), { name: 'legacy-events', status: 'disabled', scope: 'user', transport: 'sse',
    endpointOrigin: 'http://127.0.0.1:8931', toolCount: null, detail: null });
  assert.deepEqual(server(snapshot, 'policy'), { name: 'policy', status: 'connected', scope: 'managed', transport: 'http',
    endpointOrigin: 'https://mcp.corp.example:8443', toolCount: 0, detail: null });
  assert.equal(server(snapshot, 'enterprise').scope, 'managed');
  for (const name of ['ide', 'typed-oddly', 'prototype']) {
    const odd = server(snapshot, name);
    assert.deepEqual([odd.status, odd.scope, odd.transport, odd.endpointOrigin], ['unknown', 'unknown', 'unknown', null], name);
  }
  assert.equal(server(snapshot, 'null-type').transport, 'stdio');
  assert.deepEqual(server(snapshot, 'bare'), { name: 'bare', status: 'unknown', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null });
});

test('Codex statuses, scopes and transports map to the closed wire enums', () => {
  const tools = { search: { name: 'search', description: 'Search', inputSchema: { type: 'object' } }, fetch: { name: 'fetch', inputSchema: { type: 'object' } } };
  const startup = 'MCP startup failed: handshaking with MCP server failed: connection closed: initialize response';
  const snapshot = codex([
    codexEntry('codex_apps', { httpOrigin: 'https://chatgpt.com', serverInfo: { name: 'codex-apps' }, tools, authStatus: 'bearerToken' }),
    codexEntry('broken', { toolsError: startup }),
    codexEntry('off'),
    codexEntry('oauth', { httpOrigin: 'https://mcp.linear.app', authStatus: 'notLoggedIn', toolsError: 'login required' }),
    codexEntry('plugin-docs', { pluginId: 'docs@openai', serverInfo: { name: 'docs' }, authStatus: 'oAuth' }),
    codexEntry('blank-error', { toolsError: '  \n' }),
    codexEntry('rt-connected', { runtimeStatus: 'connected', toolsError: 'ignored' }),
    codexEntry('rt-starting', { runtimeStatus: 'starting' }),
    codexEntry('rt-auth', { runtimeStatus: 'authenticationRequired' }),
    codexEntry('rt-failed', { runtimeStatus: 'failed', toolsError: 'spawn failed' }),
    codexEntry('rt-cancelled', { runtimeStatus: 'cancelled' }),
    codexEntry('rt-disabled', { runtimeStatus: 'disabled', serverInfo: { name: 'x' } }),
    codexEntry('rt-not-started', { runtimeStatus: 'notStarted', serverInfo: { name: 'x' } }),
    codexEntry('rt-future', { runtimeStatus: 'hibernating', authStatus: 'notLoggedIn' }),
    codexEntry('rt-prototype', { runtimeStatus: 'constructor' }),
    codexEntry('rt-typed-oddly', { runtimeStatus: 4 }),
    { name: 'minimal' },
  ]);
  assert.deepEqual([snapshot.provider, snapshot.truncated], ['codex', false]);
  const status = (name: string) => server(snapshot, name).status;
  assert.deepEqual(server(snapshot, 'codex_apps'), { name: 'codex_apps', status: 'connected', scope: 'unknown', transport: 'http',
    endpointOrigin: 'https://chatgpt.com', toolCount: 2, detail: null });
  assert.deepEqual(server(snapshot, 'broken'), { name: 'broken', status: 'failed', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: 0, detail: startup });
  assert.equal(status('off'), 'unknown');
  assert.deepEqual(server(snapshot, 'oauth'), { name: 'oauth', status: 'needsAuth', scope: 'unknown', transport: 'http',
    endpointOrigin: 'https://mcp.linear.app', toolCount: 0, detail: null });
  assert.deepEqual(server(snapshot, 'plugin-docs'), { name: 'plugin-docs', status: 'connected', scope: 'plugin', transport: 'stdio', endpointOrigin: null, toolCount: 0, detail: null });
  assert.equal(status('blank-error'), 'unknown');
  assert.deepEqual([status('rt-connected'), server(snapshot, 'rt-connected').detail], ['connected', null]);
  assert.equal(status('rt-starting'), 'connecting');
  assert.equal(status('rt-auth'), 'needsAuth');
  assert.deepEqual([status('rt-failed'), server(snapshot, 'rt-failed').detail], ['failed', 'spawn failed']);
  assert.deepEqual([status('rt-cancelled'), server(snapshot, 'rt-cancelled').detail], ['failed', null]);
  assert.equal(status('rt-disabled'), 'disabled');
  for (const name of ['rt-not-started', 'rt-future', 'rt-prototype', 'rt-typed-oddly']) assert.equal(status(name), 'unknown', name);
  assert.deepEqual(server(snapshot, 'minimal'), { name: 'minimal', status: 'unknown', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null });
});

test('Codex servers disabled in the effective config become disabled without detail unless they are live', () => {
  const config = { config: { model: MARKER, instructions: MARKER, mcp_servers: {
    off: { command: `/opt/${MARKER}/server`, args: [MARKER], env: { TOKEN: MARKER }, enabled: false },
    weboff: { url: `https://host/${MARKER}`, enabled: false },
    on: { command: 'npx', enabled: true }, defaulted: { command: 'npx' }, truthy: { enabled: 'false' }, zero: { enabled: 0 }, scalar: false,
    connected: { enabled: false }, starting: { enabled: false }, failing: { enabled: false }, running: { enabled: false }, login: { enabled: false },
    cancelled: { enabled: false }, absent: { enabled: false },
  } }, origins: { [MARKER]: MARKER } };
  const listed = codex([codexEntry('off'), codexEntry('weboff', { httpOrigin: 'http://127.0.0.1:9' }), codexEntry('on'), codexEntry('defaulted'), codexEntry('truthy'),
    codexEntry('zero'), codexEntry('scalar'), codexEntry('connected', { serverInfo: { name: 'x' } }), codexEntry('starting', { runtimeStatus: 'starting' }),
    codexEntry('failing', { toolsError: `spawn /opt/${MARKER}/server ENOENT` }), codexEntry('running', { runtimeStatus: 'notStarted' }), codexEntry('login', { authStatus: 'notLoggedIn' }),
    codexEntry('cancelled', { runtimeStatus: 'cancelled', toolsError: 'cancelled by user' }), codexEntry('unlisted', { toolsError: 'Connection closed' })]);
  const states = (snapshot: McpServers) => Object.fromEntries(snapshot.servers.map(entry => [entry.name, [entry.status, entry.detail]]));
  assert.deepEqual(states(listed), { cancelled: ['failed', 'cancelled by user'], connected: ['connected', null], defaulted: ['unknown', null], failing: ['failed', 'spawn [redacted] ENOENT'],
    login: ['needsAuth', null], off: ['unknown', null], on: ['unknown', null], running: ['unknown', null], scalar: ['unknown', null], starting: ['connecting', null],
    truthy: ['unknown', null], unlisted: ['failed', 'Connection closed'], weboff: ['unknown', null], zero: ['unknown', null] });
  const marked = markCodexDisabledMcpServers(listed, config);
  assert.deepEqual(states(marked), { cancelled: ['disabled', null], connected: ['connected', null], defaulted: ['unknown', null], failing: ['disabled', null],
    login: ['disabled', null], off: ['disabled', null], on: ['unknown', null], running: ['disabled', null], scalar: ['unknown', null], starting: ['connecting', null],
    truthy: ['unknown', null], unlisted: ['failed', 'Connection closed'], weboff: ['disabled', null], zero: ['unknown', null] });
  assert.deepEqual(validateMcpServers(marked), marked);
  assert.equal(JSON.stringify(marked).includes(MARKER), false);
  assert.deepEqual([marked.version, marked.provider, marked.truncated, names(marked)], [1, 'codex', false, names(listed)]);
  assert.deepEqual(server(marked, 'weboff'), { name: 'weboff', status: 'disabled', scope: 'unknown', transport: 'http', endpointOrigin: 'http://127.0.0.1:9', toolCount: 0, detail: null });
  assert.equal(listed.servers.find(entry => entry.name === 'failing')?.status, 'failed');
  for (const unusable of [null, undefined, 'x', [], {}, { config: null }, { config: [] }, { config: {} }, { config: { mcp_servers: null } }, { config: { mcp_servers: [{ enabled: false }] } },
    { mcp_servers: { off: { enabled: false } } }])
    assert.equal(markCodexDisabledMcpServers(listed, unusable), listed, JSON.stringify(unusable));
  const inherited = codex([codexEntry('constructor'), codexEntry('toString'), codexEntry('__proto__')]);
  assert.deepEqual(markCodexDisabledMcpServers(inherited, { config: { mcp_servers: {} } }).servers.map(entry => entry.status), ['unknown', 'unknown', 'unknown']);
  const truncated = markCodexDisabledMcpServers(parseCodexMcpServers({ data: [codexEntry('off')], nextCursor: '2' }), config);
  assert.deepEqual([truncated.truncated, truncated.servers[0]?.status], [true, 'disabled']);
});

test('servers are sorted by name in UTF-8 byte order', () => {
  const snapshot = claude([{ name: 'zeta' }, { name: 'alpha' }, { name: 'Zulu' }, { name: 'émile' }, { name: 'beta 2' }, { name: 'beta' }, { name: '\u{1f600}' }, { name: '\uff5e' }]);
  assert.deepEqual(names(snapshot), ['Zulu', 'alpha', 'beta', 'beta 2', 'zeta', 'émile', '\uff5e', '\u{1f600}']);
  assert.equal(snapshot.truncated, false);
});

test('invalid and duplicate names are dropped and mark the snapshot truncated', () => {
  const widest = 'n'.repeat(MCP_SERVERS_LIMITS.maxNameBytes);
  for (const invalid of [{ name: '' }, { name: ' docs' }, { name: 'docs ' }, { name: 'docs\nrm -rf' }, { name: 'docs\u007f' }, { name: 'docs\u202e' }, { name: '\u2066docs' },
    { name: 'do\u200fcs' }, { name: 'do\u200ecs\u2069' }, { name: '\u202adocs' }, { name: 'docs\u202b' }, { name: 'docs\u202c' }, { name: 'docs\u202d' }, { name: 'docs\u2067' },
    { name: 'docs\u2068' }, { name: 'docs\ud800' }, { name: `${widest}n` }, { name: 12 }, { status: 'connected' }, 'docs', null, ['docs']]) {
    const label = JSON.stringify(invalid);
    assert.deepEqual([names(claude([{ name: 'kept', status: 'connected' }, invalid])), claude([{ name: 'kept' }, invalid]).truncated], [['kept'], true], label);
    assert.deepEqual([names(codex([codexEntry('kept'), invalid])), codex([codexEntry('kept'), invalid]).truncated], [['kept'], true], label);
  }
  for (const name of ['', ' docs', 'docs ', 'docs\nrm -rf', 'docs\u007f', 'docs\u202e', '\u2066docs', 'do\u200fcs', 'do\u200ecs', 'docs\ud800', `${widest}n`, 12, null, undefined])
    assert.equal(isValidMcpServerName(name), false, JSON.stringify(name));
  for (const valid of ['claude.ai Gmail', widest, 'é'.repeat(64), 'codex_apps']) assert.equal(isValidMcpServerName(valid), true, valid);
  const snapshot = claude([{ name: 'docs', status: 'connected' }, { name: 'docs', status: 'failed', error: 'second' }, { name: widest, status: 'connected' }]);
  assert.deepEqual(names(snapshot), ['docs', widest]);
  assert.deepEqual([server(snapshot, 'docs').status, snapshot.truncated], ['connected', true]);
  const twins = codex([codexEntry('docs', { serverInfo: {} }), codexEntry('docs', { toolsError: 'second' })]);
  assert.deepEqual([names(twins), twins.servers[0]!.status, twins.truncated], [['docs'], 'connected', true]);
});

test('more servers than the limit and a Codex next cursor mark the snapshot truncated', () => {
  const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `server-${String(index).padStart(4, '0')}`, status: 'connected' }));
  const exact = claude(entries(MCP_SERVERS_LIMITS.maxServers));
  assert.deepEqual([exact.servers.length, exact.truncated], [128, false]);
  const over = claude(entries(MCP_SERVERS_LIMITS.maxServers + 1));
  assert.deepEqual([over.servers.length, over.truncated, over.servers.at(-1)!.name], [128, true, 'server-0127']);
  const codexOver = codex(Array.from({ length: 133 }, (_, index) => codexEntry(`server-${index}`)));
  assert.deepEqual([codexOver.servers.length, codexOver.truncated], [128, true]);
  const page = (nextCursor: unknown) => parseCodexMcpServers({ data: [codexEntry('docs')], nextCursor }).truncated;
  assert.deepEqual([page('2'), page(7), page(''), page(null), page(undefined)], [true, true, true, false, false]);
  assert.equal(parseCodexMcpServers({ data: [codexEntry('docs')] }).truncated, false);
});

test('payloads without a server list are rejected and empty lists are valid', () => {
  for (const payload of [{}, { mcpServers: null }, { mcpServers: {} }, [], null, 'x', undefined]) assert.throws(() => parseClaudeMcpServers(payload), rejected, JSON.stringify(payload));
  for (const payload of [{}, { data: null }, { data: {} }, 'x', null, [], undefined]) assert.throws(() => parseCodexMcpServers(payload), rejected, JSON.stringify(payload));
  assert.deepEqual(claude([]), { version: 1, provider: 'claude', truncated: false, servers: [] });
  assert.deepEqual(codex([]), { version: 1, provider: 'codex', truncated: false, servers: [] });
});

test('tool counts are reported only when present and within the limit', () => {
  const limit = MCP_SERVERS_LIMITS.maxToolCount;
  const list = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `tool-${index}` }));
  const map = (count: number) => Object.fromEntries(list(count).map(tool => [tool.name, {}]));
  const fromClaude = claude([{ name: 'limit', tools: list(limit) }, { name: 'over', tools: list(limit + 1) }, { name: 'absent' }, { name: 'mistyped', tools: { a: 1 } }, { name: 'none', tools: [] }]);
  assert.deepEqual(fromClaude.servers.map(entry => [entry.name, entry.toolCount]), [['absent', null], ['limit', limit], ['mistyped', null], ['none', 0], ['over', null]]);
  const fromCodex = codex([codexEntry('limit', { tools: map(limit) }), codexEntry('over', { tools: map(limit + 1) }), codexEntry('null', { tools: null }),
    codexEntry('mistyped', { tools: [1, 2] }), codexEntry('none')]);
  assert.deepEqual(fromCodex.servers.map(entry => [entry.name, entry.toolCount]), [['limit', limit], ['mistyped', null], ['none', 0], ['null', null], ['over', null]]);
});

test('failure details are single-line, bounded and only present for failed servers', () => {
  assert.equal(claudeDetail('  spawn failed\r\n\tENOENT\u0000\u001b[31m  '), 'spawn failed ENOENT [31m');
  for (const empty of ['', ' \n\t ', null, undefined, { message: 'nested' }, 7, ['x']]) assert.equal(claudeDetail(empty), null, JSON.stringify(empty));
  for (const status of ['connected', 'pending', 'needs-auth', 'disabled', 'other']) assert.equal(claudeDetail('Connection closed', status), null, status);
  assert.equal(claudeDetail('é'.repeat(400)), 'é'.repeat(128));
  assert.equal(claudeDetail(`a${'é'.repeat(400)}`), `a${'é'.repeat(127)}`);
  assert.equal(claudeDetail(`${'abc '.repeat(64)}tail`), 'abc '.repeat(64).trimEnd());
  assert.equal(claudeDetail('lone \ud800 surrogate'), 'lone \ufffd surrogate');
  const huge = claudeDetail('word '.repeat(200_000));
  assert.equal(huge, `${'word '.repeat(51)}w`);
  assert.equal(Buffer.byteLength(huge ?? ''), MCP_SERVERS_LIMITS.maxDetailBytes);
  assert.equal(sanitizeMcpFailureDetail('Connection closed'), 'Connection closed');
});

test('URLs inside failure details are reduced to their origin', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`HTTP request failed: error sending request for url (http://127.0.0.1:9/mcp/path?token=${MARKER}), when send initialize request`,
      'HTTP request failed: error sending request for url (http://127.0.0.1:9 when send initialize request'],
    [`dial https://user:${MARKER}@Mcp.Example.com:8443/v1?key=${MARKER}#${MARKER} failed`, 'dial https://mcp.example.com:8443 failed'],
    [`TypeError dialing http://REDACTED:REDACTED@127.0.0.1:9[redacted]?token=${MARKER} (ECONNREFUSED)`, 'TypeError dialing [redacted] (ECONNREFUSED)'],
    [`connect url=postgres://admin:${MARKER}@db/prod and wss://h/${MARKER}`, 'connect [redacted] and [redacted]'],
    [`a=https://one.example/${MARKER},b=https://two.example/x?${MARKER}`, '[redacted]'],
    [`see (https://one.example/${MARKER}) and "wss://h/${MARKER}"`, 'see (https://one.example and "[redacted]'],
    [`é://${MARKER} ://${MARKER}`, 'é[redacted] [redacted]'],
    [`\u017fttp://one.example/${MARKER} HTTP\u212a://two.example/${MARKER}`, '\u017f[redacted] HTTP\u212a[redacted]'],
    [`${'x'.repeat(4066)} https://tail.example/${MARKER}`, '[redacted]'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(codexDetail(message), expected, message.slice(0, 80));
    assert.equal(claudeDetail(message), expected, message.slice(0, 80));
  }
});

test('ordinary failure messages stay readable', () => {
  for (const message of ['Connection closed', 'MCP error -32000: Connection closed', 'Connection timed out after 30000ms', 'No such file or directory (os error 2)',
    'HTTP 401 Unauthorized', 'SSE error: ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
    'MCP startup failed: handshaking with MCP server failed: connection closed: initialize response', 'exited with code -1.', 'value -0.5 rejected - retry later',
    'stdin -- closed (a -> b)', 'fifteen abcdefghijklmno and split abcdefgh.ijklmnop runs', 'server misconfiguration detected', 'state authenticationRequired reported',
    'sixteen abcdefghijklmnop letters', 'thirty-one abcdefghijklmnopqrstuvwxyzabcde letters', 'fifteen with digits abcdefghijklmn1', 'login required']) {
    assert.equal(claudeDetail(message), message);
    assert.equal(codexDetail(message), message);
  }
});

test('sensitive words inside failure details are redacted', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`failed to spawn \`/opt/acme/server --token ${MARKER}\`: No such file`, 'failed to spawn [redacted] No such file'],
    ['spawn /opt/acme/server ENOENT', 'spawn [redacted] ENOENT'],
    [`env API_KEY=${MARKER} rejected`, 'env [redacted] rejected'],
    [`"TOKEN=${MARKER}" rejected`, '[redacted] rejected'],
    [`(path/${MARKER}) missing`, '[redacted] missing'],
    [`C:\\Users\\${MARKER} missing`, '[redacted] missing'],
    [`login as user@${MARKER} failed`, 'login as [redacted] failed'],
    [`bad key sk_live_${MARKER}_0123456789 used`, 'bad key [redacted] used'],
    ['sixteen abcdefghijklmno1 with a digit', 'sixteen [redacted] with a digit'],
    ['thirty-two abcdefghijklmnopqrstuvwxyzabcdef letters', 'thirty-two [redacted] letters'],
    ['wrapped (a1b2c3d4e5f6a7b8), token', 'wrapped [redacted] token'],
    [`args: --api-key ${MARKER} -p ${MARKER} done`, 'args: [redacted] done'],
    [`'--token' '${MARKER}' failed`, '[redacted] failed'],
    [`run (\`-k\` ${MARKER}`, 'run [redacted]'],
    [`--flag=${MARKER} next kept`, '[redacted] kept'],
    [`-5s ${MARKER} kept`, '[redacted] kept'],
    [`--5 ${MARKER} kept`, '[redacted] kept'],
    [`--url https://one.example/${MARKER} kept`, '[redacted] kept'],
    [`TOKEN=${MARKER},https://one.example/x kept`, '[redacted] kept'],
    ['Connection\u202e closed\u2066', 'Connection closed'],
    ['split abcdefg1\u200eijklmnop run', 'split [redacted] run'],
    [`\u200f/opt/${MARKER}\u202a`, '[redacted]'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(claudeDetail(message), expected, message);
    assert.equal(codexDetail(message), expected, message);
  }
});

test('a word cut by the raw detail bound is dropped', () => {
  const cut = `${'/x '.repeat(1364)}${MARKER}_0123456789`;
  assert.ok(Buffer.byteLength(cut) > 4096);
  assert.equal(claudeDetail(cut), '[redacted]');
  assert.equal(claudeDetail('y'.repeat(4097)), null);
  assert.equal(claudeDetail(`kept ${'é'.repeat(2046)}`), 'kept');
  assert.equal(claudeDetail(`${'kept '.repeat(819)}${MARKER}`), `${'kept '.repeat(51)}k`);
});

test('endpoint origins keep only scheme, host and port', () => {
  const reduced: readonly (readonly [string, string])[] = [
    ['https://mcp.sentry.dev/mcp?token=secret', 'https://mcp.sentry.dev'], ['https://user:secret@mcp.sentry.dev', 'https://mcp.sentry.dev'],
    ['https://user:p@ss@mcp.sentry.dev/x', 'https://mcp.sentry.dev'], ['HTTPS://MCP.Sentry.DEV:8443/Path', 'https://mcp.sentry.dev:8443'],
    ['http://127.0.0.1:8931/sse', 'http://127.0.0.1:8931'], ['http://localhost#fragment', 'http://localhost'], ['http://[::1]:9000/mcp', 'http://[::1]:9000'],
    ['http://[2001:DB8::1]', 'http://[2001:db8::1]'], ['https://evil.example\\@good.example/x', 'https://evil.example'], ['https://chatgpt.com', 'https://chatgpt.com'],
    ['https://host:65535/x', 'https://host:65535'], ['http://host:1', 'http://host:1'], ['http://[::1]:65535', 'http://[::1]:65535'],
  ];
  for (const [url, expected] of reduced) {
    assert.equal(endpointOrigin(url), expected, url);
    assert.ok(MCP_ENDPOINT_ORIGIN_PATTERN.test(expected) && isValidEndpointOrigin(expected), expected);
  }
  for (const url of ['', 'mcp.sentry.dev', 'ws://127.0.0.1:4000', 'file:///etc/passwd', 'https://', 'https:///path', 'https://?query', 'https://user@', 'https://host:port',
    'https://host:123456', 'https://host:0', 'https://host:00000', 'https://host:65536', 'https://host:99999', 'http://[::1]:0', 'http://[::1]:70000', 'https://host:',
    'https://ho st/path', 'https://host\u0000', 'https://[::1', 'https://[::1]x', 'https://[zz]', 'https://[]', 'https://émile.example', 'https://\u212aelvin.example',
    ' https://mcp.sentry.dev', 'é', `https://${'a'.repeat(256)}.example/x`])
    assert.equal(endpointOrigin(url), null, JSON.stringify(url));
  for (const origin of ['https://mcp.sentry.dev/', 'https://mcp.sentry.dev/mcp', 'https://user:secret@mcp.sentry.dev', 'https://mcp.sentry.dev?x', 'https://mcp.sentry.dev#x',
    'HTTPS://mcp.sentry.dev', 'ftp://mcp.sentry.dev', 'https://mcp sentry.dev', 'https://', 'https://host:65536'])
    assert.equal(isValidEndpointOrigin(origin), false, origin);
});

test('stdio servers never carry an endpoint origin', () => {
  const fromClaude = claude([{ name: 'typed', config: { type: 'stdio', command: 'npx', url: 'https://leak.example/x' } },
    { name: 'untyped', config: { command: 'npx', url: 'https://leak.example/x' } }, { name: 'no-config', url: 'https://leak.example/x' }]);
  assert.deepEqual(fromClaude.servers.map(entry => entry.endpointOrigin), [null, null, null]);
  const fromCodex = codex([codexEntry('typed-oddly', { httpOrigin: 5 }), codexEntry('with-path', { httpOrigin: 'https://user:pw@chatgpt.com/backend?x=1' }),
    codexEntry('invalid', { httpOrigin: 'not a url' })]);
  assert.deepEqual(fromCodex.servers.map(entry => [entry.name, entry.transport, entry.endpointOrigin]),
    [['invalid', 'http', null], ['typed-oddly', 'http', null], ['with-path', 'http', 'https://chatgpt.com']]);
});

test('a marker secret in provider configuration, URLs and error text never reaches the serialized snapshot', () => {
  const errors = [`spawn /opt/${MARKER}/server ENOENT`, `open C:\\tools\\${MARKER}\\server.exe failed`, `env API_TOKEN=${MARKER} rejected`, `env "API_TOKEN=${MARKER}", rejected`,
    `failed: server --token ${MARKER} exited`, `failed: server -t '${MARKER}' exited`, `failed to spawn \`/opt/acme/server --token ${MARKER}\`: No such file`,
    `failed to spawn "/opt/${MARKER}/server" "--api-key" "${MARKER}"`, `failed to spawn \`server --key=${MARKER}\``, `invalid key sk_live_${MARKER}_0123456789abcdef`,
    `invalid key (${MARKER}${MARKER}${MARKER}),`, `request to https://mcp.example.com:8443/v1/${MARKER}?token=${MARKER}#${MARKER} failed`];
  for (const error of errors) {
    for (const snapshot of [claude([{ name: 'docs', status: 'failed', error }]), codex([codexEntry('docs', { toolsError: error })])]) {
      const serialized = JSON.stringify(validateMcpServers(snapshot));
      assert.equal(serialized.includes(MARKER), false, `${error}: ${serialized}`);
      assert.match(snapshot.servers[0]!.detail ?? '', /\[redacted\]|https:\/\/mcp\.example\.com:8443/, error);
    }
  }
  const fromClaude = claude([
    { name: 'local-tools', status: 'failed', error: `spawn failed for https://internal.example/${MARKER}?token=${MARKER}`,
      config: { type: 'stdio', command: `/opt/${MARKER}/server`, args: ['--api-key', MARKER], env: { API_TOKEN: MARKER } },
      scope: 'project', source: `project-${MARKER}`, serverInfo: { name: MARKER, version: MARKER },
      tools: [{ name: `tool-${MARKER}`, description: MARKER, annotations: { title: MARKER } }] },
    { name: 'remote-tools', status: 'connected', pid: 4242, scope: 'user', tools: [{ name: MARKER, inputSchema: { description: MARKER } }],
      config: { type: 'http', url: `https://user:${MARKER}@mcp.example.com:8443/v1/${MARKER}?token=${MARKER}#${MARKER}`,
        headers: { Authorization: `Bearer ${MARKER}` }, id: `mcpsrv_${MARKER}` } },
  ]);
  const fromCodex = codex([codexEntry('remote-tools', {
    httpOrigin: `https://user:${MARKER}@mcp.example.com:8443/v1/${MARKER}?token=${MARKER}`, pluginId: `plugin-${MARKER}`, serverInfo: { name: MARKER },
    serverCapabilities: { experimental: MARKER }, tools: { [MARKER]: { name: MARKER, description: MARKER, inputSchema: { title: MARKER } } },
    toolsError: `request to https://mcp.example.com:8443/v1/${MARKER}?token=${MARKER} failed`, resources: [{ uri: MARKER }], resourceTemplates: [{ uriTemplate: MARKER }],
    authStatus: 'bearerToken',
  })]);
  for (const snapshot of [fromClaude, fromCodex]) {
    const serialized = JSON.stringify(validateMcpServers(snapshot));
    assert.equal(serialized.includes(MARKER), false, serialized);
    assert.equal(serialized.includes('4242'), false, serialized);
  }
  assert.deepEqual(fromClaude.servers, [
    { name: 'local-tools', status: 'failed', scope: 'project', transport: 'stdio', endpointOrigin: null, toolCount: 1, detail: 'spawn failed for https://internal.example' },
    { name: 'remote-tools', status: 'connected', scope: 'user', transport: 'http', endpointOrigin: 'https://mcp.example.com:8443', toolCount: 1, detail: null },
  ]);
  assert.deepEqual(fromCodex, { version: 1, provider: 'codex', truncated: false, servers: [
    { name: 'remote-tools', status: 'failed', scope: 'plugin', transport: 'http', endpointOrigin: 'https://mcp.example.com:8443', toolCount: 1,
      detail: 'request to https://mcp.example.com:8443 failed' },
  ] });
});
