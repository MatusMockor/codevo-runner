import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_SERVERS_LIMITS, type McpServers } from '../src/domain/mcp-servers.js';
import {
  CLAUDE_MCP_INITIALIZE_REQUEST, CLAUDE_MCP_INITIALIZE_REQUEST_ID, CODEX_MCP_INITIALIZE_REQUEST, ClaudeMcpStatusPoll, CodexMcpStatusRequest,
  MAX_CLAUDE_MCP_STATUS_POLLS, MCP_STATUS_TIMING, claudeMcpStatusRequestId, type McpProbeStep,
} from '../src/domain/mcp-servers-probe.js';

const WAIT = { kind: 'wait' };
const DONE = { kind: 'done' };
const CWD = '/srv/project';
const failed = (failure: string) => ({ kind: 'failed', failure });
const line = (value: unknown) => JSON.stringify(value);
const claudeSuccess = (requestId: unknown, response: unknown) => line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
const claudeServers = (requestId: unknown, servers: unknown) => claudeSuccess(requestId, { mcpServers: servers });
const claudeError = (requestId: string) => line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported control request subtype: mcp_status' } });
const claudeInitialized = () => claudeSuccess(CLAUDE_MCP_INITIALIZE_REQUEST_ID, { commands: [{ name: 'review' }], pid: 4242 });
const statuses = (snapshot: McpServers | undefined) => snapshot?.servers.map(server => [server.name, server.status]);

function writtenRequests(step: McpProbeStep): readonly unknown[] {
  assert.equal(step.kind, 'write');
  return step.kind === 'write' ? step.requests : [];
}
function writtenRequestId(step: McpProbeStep): string {
  const requests = writtenRequests(step);
  assert.equal(requests.length, 1);
  const request = requests[0] as Readonly<Record<string, unknown>>;
  assert.deepEqual(request, { type: 'control_request', request_id: request.request_id, request: { subtype: 'mcp_status' } });
  assert.match(String(request.request_id), /^codevo-mcp-servers-status-[1-9][0-9]*$/);
  return String(request.request_id);
}
function initializedClaude(at = 0, timing = MCP_STATUS_TIMING): ClaudeMcpStatusPoll {
  const poll = new ClaudeMcpStatusPoll(timing);
  assert.deepEqual(poll.step(at), WAIT);
  poll.observe(claudeInitialized(), at);
  return poll;
}
function answer(poll: ClaudeMcpStatusPoll, now: number, servers: unknown): McpProbeStep {
  const step = poll.step(now);
  if (step.kind === 'write') poll.observe(claudeServers(writtenRequestId(step), servers), now);
  return step;
}
function answerEvery100ms(poll: ClaudeMcpStatusPoll, from: number, until: number, servers: unknown): number {
  let written = 0;
  for (let now = from; now < until; now += 100) written += answer(poll, now, servers).kind === 'write' ? 1 : 0;
  return written;
}
const codexEntry = (name: string, changed: Readonly<Record<string, unknown>> = {}) => ({
  name, runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: { name }, tools: { search: { name: 'search', inputSchema: { type: 'object' } } },
  toolsError: null, authStatus: 'unsupported', ...changed,
});
const STATUS_REQUEST = { id: 1, method: 'mcpServerStatus/list', params: { detail: 'toolsAndAuthOnly', limit: MCP_SERVERS_LIMITS.maxServers } };
const CONFIG_REQUEST = { id: 2, method: 'config/read', params: { cwd: CWD, includeLayers: false } };
const DISABLED_CONFIG = { config: { model: 'secret', mcp_servers: { off: { command: '/opt/secret/server', enabled: false }, docs: { enabled: false }, broken: { enabled: false } } } };
const listedData = [codexEntry('off', { serverInfo: null, tools: {} }), codexEntry('docs'), codexEntry('broken', { serverInfo: null, toolsError: 'Connection closed' })];
const listedStatuses = [['broken', 'failed'], ['docs', 'connected'], ['off', 'unknown']];
function requestedCodex(): CodexMcpStatusRequest {
  const request = new CodexMcpStatusRequest(CWD);
  assert.deepEqual(request.step(0), WAIT);
  request.observe(line({ id: 0, result: { userAgent: 'codevo-runner' } }));
  assert.deepEqual(writtenRequests(request.step(0)), [{ method: 'initialized', params: {} }, STATUS_REQUEST]);
  return request;
}
function listedCodex(at: number, data: readonly unknown[] = listedData): CodexMcpStatusRequest {
  const request = requestedCodex();
  request.observe(line({ id: 1, result: { data, nextCursor: null } }));
  assert.deepEqual(writtenRequests(request.step(at)), [CONFIG_REQUEST]);
  return request;
}

test('probe timing and the constant requests match the reference', () => {
  assert.deepEqual(MCP_STATUS_TIMING, { pollMs: 500, stableMs: 2_000, settleMs: 20_000, configMs: 5_000 });
  assert.equal(MAX_CLAUDE_MCP_STATUS_POLLS, 48);
  assert.equal(JSON.stringify(CLAUDE_MCP_INITIALIZE_REQUEST), '{"type":"control_request","request_id":"codevo-mcp-servers-initialize","request":{"subtype":"initialize"}}');
  assert.equal(JSON.stringify(CODEX_MCP_INITIALIZE_REQUEST),
    '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"codevo-runner","title":"Codevo Runner","version":"0.1.0"}}}');
  assert.equal(claudeMcpStatusRequestId(3), 'codevo-mcp-servers-status-3');
  assert.throws(() => { (CLAUDE_MCP_INITIALIZE_REQUEST as Record<string, unknown>).type = 'user'; }, TypeError);
});

test('Claude requests status only after initialize succeeds', () => {
  const poll = new ClaudeMcpStatusPoll();
  assert.deepEqual(poll.step(0), WAIT);
  assert.deepEqual(poll.step(5_000), WAIT);
  poll.observe(claudeInitialized(), 5_000);
  assert.equal(writtenRequestId(poll.step(5_000)), claudeMcpStatusRequestId(1));
  assert.deepEqual(poll.step(9_000), WAIT);
  assert.equal(poll.snapshot(), undefined);

  const rejected = new ClaudeMcpStatusPoll();
  rejected.observe(line({ type: 'control_response', response: { subtype: 'error', request_id: CLAUDE_MCP_INITIALIZE_REQUEST_ID, error: 'nope' } }), 0);
  assert.deepEqual(rejected.step(0), failed('handshake'));
  assert.deepEqual(rejected.step(60_000), failed('handshake'));
});

test('Claude polls again while a server is pending and settles once the list is stable and confirmed', () => {
  const poll = initializedClaude();
  const first = writtenRequestId(poll.step(0));
  poll.observe(claudeServers(first, []), 100);
  assert.deepEqual(poll.step(400), WAIT);
  const second = writtenRequestId(poll.step(500));
  assert.notEqual(second, first);
  const pending = [{ name: 'docs', status: 'pending', config: { type: 'http', url: 'https://docs.example/mcp' }, scope: 'user' }, { name: 'gmail', status: 'needs-auth', scope: 'claudeai' }];
  poll.observe(claudeServers(second, pending), 600);
  assert.deepEqual(poll.step(999), WAIT);
  poll.observe(claudeServers(writtenRequestId(poll.step(1_000)), pending), 1_100);
  const settled = [{ name: 'docs', status: 'connected', config: { type: 'http', url: 'https://docs.example/mcp' }, scope: 'user', tools: [{ name: 'search' }] },
    { name: 'gmail', status: 'needs-auth', scope: 'claudeai' }];
  assert.equal(answerEvery100ms(poll, 4_000, 6_000, settled), 4);
  assert.equal(answer(poll, 6_000, settled).kind, 'write');
  assert.deepEqual(poll.step(6_000), DONE);
  assert.deepEqual(poll.step(9_000), DONE);
  assert.deepEqual(poll.snapshot(), { version: 1, provider: 'claude', truncated: false, servers: [
    { name: 'docs', status: 'connected', scope: 'user', transport: 'http', endpointOrigin: 'https://docs.example', toolCount: 1, detail: null },
    { name: 'gmail', status: 'needsAuth', scope: 'account', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null },
  ] });
});

test('Claude does not settle on an early empty list that later gains servers', () => {
  const poll = initializedClaude();
  poll.observe(claudeServers(writtenRequestId(poll.step(0)), []), 100);
  const late = [{ name: 'late', status: 'connected' }];
  assert.equal(answerEvery100ms(poll, 500, 1_900, []), 3);
  assert.equal(answer(poll, 2_000, late).kind, 'write');
  assert.deepEqual(poll.step(2_300), WAIT);
  assert.equal(answerEvery100ms(poll, 2_400, 4_000, late), 3);
  assert.equal(answer(poll, 4_000, late).kind, 'write');
  assert.deepEqual(poll.step(4_000), DONE);
  assert.deepEqual(statuses(poll.snapshot()), [['late', 'connected']]);
});

test('Claude settles on a stable empty list only after a later poll confirmed it', () => {
  const unconfirmed = initializedClaude();
  unconfirmed.observe(claudeServers(writtenRequestId(unconfirmed.step(0)), []), 50);
  assert.equal(unconfirmed.step(10_000).kind, 'write');
  assert.deepEqual(unconfirmed.step(15_000), WAIT);
  const poll = initializedClaude();
  assert.equal(answerEvery100ms(poll, 0, 2_000, []), 4);
  assert.equal(answer(poll, 2_000, []).kind, 'write');
  assert.deepEqual(poll.step(2_000), DONE);
  assert.deepEqual(poll.snapshot(), { version: 1, provider: 'claude', truncated: false, servers: [] });
});

test('Claude returns the latest snapshot at the deadline with pending servers reported as connecting', () => {
  const poll = initializedClaude();
  const pending = [{ name: 'slow', status: 'pending', config: { type: 'stdio', command: '/bin/sleep' }, scope: 'project' }, { name: 'ready', status: 'connected', scope: 'user' }];
  assert.equal(answerEvery100ms(poll, 0, 20_000, pending), 40);
  assert.ok(40 < MAX_CLAUDE_MCP_STATUS_POLLS);
  assert.deepEqual(poll.step(19_999), WAIT);
  assert.deepEqual(poll.step(20_000), DONE);
  assert.deepEqual(statuses(poll.snapshot()), [['ready', 'connected'], ['slow', 'connecting']]);

  const silent = initializedClaude();
  writtenRequestId(silent.step(0));
  assert.deepEqual(silent.step(20_000), WAIT);
  assert.deepEqual(silent.step(60_000), WAIT);
  assert.equal(silent.snapshot(), undefined);
});

test('the Claude settle clock starts when initialize is answered', () => {
  const poll = new ClaudeMcpStatusPoll();
  assert.deepEqual(poll.step(21_000), WAIT);
  poll.observe(claudeInitialized(), 21_000);
  const pending = [{ name: 'slow', status: 'pending' }];
  assert.equal(answer(poll, 21_000, pending).kind, 'write');
  poll.observe(claudeInitialized(), 30_000);
  assert.equal(answerEvery100ms(poll, 21_100, 41_000, pending), 39);
  assert.deepEqual(poll.step(40_999), WAIT);
  assert.deepEqual(poll.step(41_000), DONE);
  assert.deepEqual(statuses(poll.snapshot()), [['slow', 'connecting']]);

  const settled = new ClaudeMcpStatusPoll();
  settled.observe(claudeInitialized(), 24_000);
  const ready = [{ name: 'ready', status: 'connected' }];
  assert.equal(answerEvery100ms(settled, 24_000, 26_000, ready), 4);
  assert.equal(answer(settled, 26_000, ready).kind, 'write');
  assert.deepEqual(settled.step(26_000), DONE);
  assert.deepEqual(statuses(settled.snapshot()), [['ready', 'connected']]);
});

test('Claude stops polling at the poll cap and returns the latest snapshot', () => {
  const poll = initializedClaude(0, { ...MCP_STATUS_TIMING, pollMs: 1, settleMs: 3_600_000 });
  const pending = [{ name: 'slow', status: 'pending' }];
  for (let index = 0; index < MAX_CLAUDE_MCP_STATUS_POLLS - 1; index++) {
    const requestId = writtenRequestId(poll.step(index * 10));
    assert.equal(requestId, claudeMcpStatusRequestId(index + 1));
    poll.observe(claudeServers(requestId, pending), index * 10);
  }
  const last = writtenRequestId(poll.step(480));
  assert.equal(last, claudeMcpStatusRequestId(MAX_CLAUDE_MCP_STATUS_POLLS));
  assert.deepEqual(poll.step(5_000), WAIT);
  poll.observe(claudeServers(last, pending), 5_000);
  assert.deepEqual(poll.step(5_001), DONE);
  assert.deepEqual(statuses(poll.snapshot()), [['slow', 'connecting']]);
});

test('Claude fails on an error response and on a success without a server list', () => {
  const poll = initializedClaude();
  poll.observe(claudeServers(writtenRequestId(poll.step(0)), [{ name: 'docs', status: 'connected' }]), 10);
  poll.observe(claudeError(writtenRequestId(poll.step(500))), 510);
  assert.deepEqual(poll.step(520), failed('request'));
  assert.deepEqual(poll.step(30_000), failed('request'));
  for (const response of [{}, { mcpServers: 'none' }, { mcpServers: { docs: {} } }, null, undefined]) {
    const invalid = initializedClaude();
    invalid.observe(claudeSuccess(writtenRequestId(invalid.step(0)), response), 0);
    assert.deepEqual(invalid.step(0), failed('payload'), JSON.stringify(response));
    assert.equal(invalid.snapshot(), undefined);
  }
});

test('Claude ignores foreign, stale and decoy lines', () => {
  const poll = initializedClaude();
  const first = writtenRequestId(poll.step(0));
  const decoy = [{ name: 'decoy', status: 'connected' }];
  for (const text of ['not json', '', '{"truncated":', claudeServers('someone-else', decoy), claudeServers(claudeMcpStatusRequestId(2), decoy),
    line({ type: 'system', subtype: 'init', mcp_servers: decoy, request_id: first }),
    line({ type: 'control_request', response: { subtype: 'success', request_id: first, response: { mcpServers: decoy } } }),
    line({ type: 'assistant', message: { content: `"request_id":"${first}" "mcpServers":[]` } }),
    claudeServers(7, decoy), line({ type: 'control_response' }), line({ type: 'control_response', response: 'text' }), line([1, 2, 3]), line(null), line('text')])
    poll.observe(text, 0);
  assert.deepEqual(poll.step(400), WAIT);
  assert.equal(poll.snapshot(), undefined);

  const real = [{ name: 'real', status: 'connected' }];
  const replayed = initializedClaude();
  const one = writtenRequestId(replayed.step(0));
  replayed.observe(claudeServers(one, real), 10);
  replayed.observe(claudeServers(one, decoy), 20);
  replayed.observe(claudeInitialized(), 30);
  const two = writtenRequestId(replayed.step(500));
  replayed.observe(claudeServers(one, decoy), 510);
  assert.deepEqual(replayed.step(3_000), WAIT);
  replayed.observe(claudeServers(two, real), 3_000);
  assert.deepEqual(replayed.step(3_000), DONE);
  assert.equal(two, claudeMcpStatusRequestId(2));
  assert.deepEqual(statuses(replayed.snapshot()), [['real', 'connected']]);
  replayed.observe(claudeServers(two, decoy), 3_100);
  assert.deepEqual(statuses(replayed.snapshot()), [['real', 'connected']]);
});

test('Codex requests the status list once after the handshake and the config only after the list arrived', () => {
  const request = new CodexMcpStatusRequest(CWD);
  assert.deepEqual(request.step(0), WAIT);
  request.observe(line({ method: 'remoteControl/status/changed', params: { status: 'disabled' } }));
  assert.deepEqual(request.step(0), WAIT);
  request.observe(line({ id: 1, result: { data: [codexEntry('before-handshake')] } }));
  request.observe(line({ id: 0, result: { userAgent: 'codevo-runner' } }));
  assert.deepEqual(writtenRequests(request.step(10)), [{ method: 'initialized', params: {} }, STATUS_REQUEST]);
  assert.deepEqual(request.step(20), WAIT);
  request.observe(line({ id: 2, result: DISABLED_CONFIG }));
  assert.deepEqual(request.step(60_000), WAIT);
  assert.equal(request.snapshot(), undefined);
  request.observe(line({ id: 1, result: { data: listedData, nextCursor: null } }));
  assert.deepEqual(statuses(request.snapshot()), listedStatuses);
  assert.deepEqual(writtenRequests(request.step(60_100)), [CONFIG_REQUEST]);
  assert.deepEqual(request.step(60_200), WAIT);
  assert.deepEqual(request.step(65_099), WAIT);
  assert.deepEqual(statuses(request.snapshot()), listedStatuses);
});

test('Codex ignores interleaved notifications and decoys, then completes', () => {
  const request = requestedCodex();
  for (const value of ['not json', '', { method: 'account/updated', params: { authMode: 'chatgpt' } }, { id: 1, method: 'item/tool/requestUserInput', params: { data: [codexEntry('server-request')] } },
    { id: 3, result: { data: [codexEntry('other-id')] } }, { id: '1', result: { data: [codexEntry('string-id')] } }, { result: { data: [codexEntry('no-id')] } },
    { id: 0, result: { data: [codexEntry('handshake-again')] } }, { id: 0, error: { message: 'late' } }, { id: 2, result: DISABLED_CONFIG }, [1, 2], null])
    request.observe(typeof value === 'string' ? value : line(value));
  assert.deepEqual(request.step(0), WAIT);
  request.observe(line({ id: 1, result: { data: [codexEntry('docs'), codexEntry('apps')], nextCursor: null } }));
  request.observe(line({ id: 1, result: { data: [codexEntry('late-decoy')] } }));
  assert.deepEqual(writtenRequests(request.step(100)), [CONFIG_REQUEST]);
  for (const value of [{ id: 1, result: { data: [codexEntry('status-again')] } }, { id: 2, method: 'config/changed', result: DISABLED_CONFIG }, { id: '2', result: DISABLED_CONFIG }, { id: 0, error: {} }])
    request.observe(line(value));
  assert.deepEqual(request.step(200), WAIT);
  request.observe(line({ id: 2, result: { config: { mcp_servers: {} } } }));
  assert.deepEqual(request.step(200), DONE);
  assert.deepEqual(request.step(90_000), DONE);
  assert.deepEqual(request.snapshot(), { version: 1, provider: 'codex', truncated: false, servers: [
    { name: 'apps', status: 'connected', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: 1, detail: null },
    { name: 'docs', status: 'connected', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: 1, detail: null },
  ] });
});

test('Codex marks servers disabled in the config unless they are live and clears their detail', () => {
  const request = listedCodex(1_000);
  assert.deepEqual(request.step(1_100), WAIT);
  request.observe(line({ id: 2, result: DISABLED_CONFIG }));
  assert.deepEqual(request.step(1_100), DONE);
  assert.deepEqual(request.snapshot()?.servers.map(server => [server.name, server.status, server.detail]),
    [['broken', 'disabled', null], ['docs', 'connected', null], ['off', 'disabled', null]]);
  assert.equal(JSON.stringify(request.snapshot()).includes('secret'), false);
  request.observe(line({ id: 2, result: { config: { mcp_servers: {} } } }));
  assert.deepEqual(statuses(request.snapshot()), [['broken', 'disabled'], ['docs', 'connected'], ['off', 'disabled']]);
});

test('Codex keeps the status list unchanged when the config read fails or is unusable', () => {
  for (const config of [{ id: 2, error: { code: -32600, message: 'Invalid request: unknown variant `config/read`' } }, { id: 2 }, { id: 2, result: null }, { id: 2, result: 'text' },
    { id: 2, result: {} }, { id: 2, result: { config: 'text' } }, { id: 2, result: { config: { mcp_servers: [{ enabled: false }] } } }, { id: 2, result: { mcp_servers: { off: { enabled: false } } } },
    { id: 2, result: { config: { mcp_servers: { off: { enabled: 'false' }, broken: false } } } }, { id: 2, error: {}, result: DISABLED_CONFIG }]) {
    const request = listedCodex(0);
    request.observe(line(config));
    assert.deepEqual(request.step(1), DONE, JSON.stringify(config));
    assert.deepEqual(request.snapshot()?.servers.map(server => [server.name, server.status, server.detail]),
      [['broken', 'failed', 'Connection closed'], ['docs', 'connected', null], ['off', 'unknown', null]], JSON.stringify(config));
  }
});

test('Codex stops waiting for a config read that never answers after five seconds on the injected clock', () => {
  const request = listedCodex(10_000);
  request.observe('not json');
  request.observe(line({ method: 'configWarning', params: {} }));
  assert.deepEqual(request.step(14_999), WAIT);
  assert.deepEqual(request.step(15_000), DONE);
  assert.deepEqual(statuses(request.snapshot()), listedStatuses);
  request.observe(line({ id: 2, result: DISABLED_CONFIG }));
  assert.deepEqual(request.step(15_001), DONE);
  assert.deepEqual(statuses(request.snapshot()), listedStatuses);
  const fast = new CodexMcpStatusRequest(CWD, { ...MCP_STATUS_TIMING, configMs: 100 });
  fast.observe(line({ id: 0, result: {} }));
  assert.equal(writtenRequests(fast.step(0)).length, 2);
  fast.observe(line({ id: 1, result: { data: [] } }));
  assert.deepEqual(writtenRequests(fast.step(50)), [CONFIG_REQUEST]);
  assert.deepEqual(fast.step(149), WAIT);
  assert.deepEqual(fast.step(150), DONE);
  assert.deepEqual(fast.snapshot(), { version: 1, provider: 'codex', truncated: false, servers: [] });
});

test('a Codex next cursor marks the snapshot truncated and survives the config pass', () => {
  const request = requestedCodex();
  request.observe(line({ id: 1, result: { data: [codexEntry('docs'), codexEntry('off', { serverInfo: null })], nextCursor: '128' } }));
  assert.equal(writtenRequests(request.step(0)).length, 1);
  request.observe(line({ id: 2, result: DISABLED_CONFIG }));
  assert.deepEqual(request.step(0), DONE);
  assert.deepEqual([request.snapshot()?.truncated, statuses(request.snapshot())], [true, [['docs', 'connected'], ['off', 'disabled']]]);
});

test('Codex fails on error responses and on a response without a server list before any list arrived', () => {
  const handshake = new CodexMcpStatusRequest(CWD);
  handshake.observe(line({ id: 0, error: { code: -32600, message: 'Invalid request' } }));
  assert.deepEqual(handshake.step(0), failed('handshake'));
  handshake.observe(line({ id: 0, result: {} }));
  assert.deepEqual(handshake.step(0), failed('handshake'));
  const request = requestedCodex();
  request.observe(line({ error: { code: -32600, message: 'Invalid request: unknown variant `mcpServerStatus/list`' }, id: 1 }));
  assert.deepEqual(request.step(0), failed('request'));
  request.observe(line({ id: 1, result: { data: [codexEntry('docs')] } }));
  assert.deepEqual(request.step(60_000), failed('request'));
  assert.equal(request.snapshot(), undefined);
  for (const response of [{ id: 1, result: {} }, { id: 1, result: { data: 'none' } }, { id: 1, result: null }, { id: 1 }]) {
    const invalid = requestedCodex();
    invalid.observe(line(response));
    assert.deepEqual(invalid.step(0), failed('payload'), JSON.stringify(response));
    assert.equal(invalid.snapshot(), undefined);
  }
});

test('Codex assembles a large response into tool counts without retaining tool data', () => {
  const tools = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`tool-${index}`, { name: `tool-${index}`, description: 'd'.repeat(400), inputSchema: { type: 'object' } }]));
  const response = line({ id: 1, result: { data: [codexEntry('codex_apps', { tools })], nextCursor: null } });
  assert.ok(response.length > 512 * 1024);
  const request = requestedCodex();
  request.observe(response);
  assert.equal(writtenRequests(request.step(0)).length, 1);
  assert.equal(request.snapshot()?.servers[0]?.toolCount, 2_000);
  assert.ok(JSON.stringify(request.snapshot()).length < 256);
});
