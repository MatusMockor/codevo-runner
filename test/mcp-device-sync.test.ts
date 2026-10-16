import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_MCP_DEVICE_SYNC_LEDGER, MCP_DEVICE_SYNC_CAPABILITY, MCP_DEVICE_SYNC_LIMITS, MCP_DEVICE_SYNC_OUTCOMES, claudeLocalServers, claudeMcpJson,
  mcpDeviceLaunchDigest, mcpDeviceSyncNames, parseClaudeStoredServer, parseMcpDeviceSyncLedger, parseMcpDeviceSyncRequest, planDeviceSync,
  preapprovedMcpServers, sameMcpDeviceSyncLedger, serializeMcpDeviceSyncLedger, settleDeviceSync, type ClaudeStoredServer, type McpDeviceLaunch,
  type McpDeviceServer, type McpDeviceSyncLedger, type McpDeviceSyncProgress, isLaunchableMcpDeviceLaunch, storedDigest,
} from '../src/domain/mcp-device-sync.js';
import { claudeMcpAddJsonPlan } from '../src/domain/mcp-server-management-cli.js';
import { isPreapprovableMcpServerName, withMcpServerPreapproval } from '../src/domain/launch-arguments.js';

const invalid = { name: 'RunnerError', code: 'invalid_input' };
const SECRET = 'DEVICE_SYNC_SECRET';
const stdio = (changed: Readonly<Record<string, unknown>> = {}) => ({ kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: SECRET }, ...changed });
const http = (changed: Readonly<Record<string, unknown>> = {}) => ({ kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` }, ...changed });
const request = (servers: readonly unknown[] = [{ name: 'docs', launch: stdio() }], retain: readonly unknown[] = [], changed: Readonly<Record<string, unknown>> = {}) =>
  ({ version: 1, servers, retain, ...changed });
const rejects = (value: unknown, label: string) => assert.throws(() => parseMcpDeviceSyncRequest(value), invalid, label);
const repeat = <T,>(count: number, value: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => value(index));

const launchA: McpDeviceLaunch = { kind: 'stdio', command: 'npx', args: ['a'], env: [['K', 'V']] };
const launchB: McpDeviceLaunch = { kind: 'stdio', command: 'npx', args: ['b'], env: [] };
const remoteC: McpDeviceLaunch = { kind: 'http', url: 'https://c.example.com/mcp', headers: [] };
const server = (name: string, launch: McpDeviceLaunch): McpDeviceServer => ({ name, launch });
const stored = (launch: McpDeviceLaunch): ClaudeStoredServer => ({ kind: 'recognized', launch });
const unrecognized: ClaudeStoredServer = { kind: 'unrecognized' };
const ledgerOf = (entries: Readonly<Record<string, McpDeviceLaunch>>): McpDeviceSyncLedger =>
  ({ kind: 'valid', servers: new Map(Object.entries(entries).map(([name, launch]) => [name, mcpDeviceLaunchDigest(launch)])) });
const corrupt: McpDeviceSyncLedger = { kind: 'corrupt' };
const applied = (...names: string[]): ReadonlyMap<string, McpDeviceSyncProgress> => new Map(names.map(name => [name, 'applied']));
const digestA = mcpDeviceLaunchDigest(launchA), digestB = mcpDeviceLaunchDigest(launchB), digestC = mcpDeviceLaunchDigest(remoteC);

test('device sync constants equal the shared contract', () => {
  assert.equal(MCP_DEVICE_SYNC_CAPABILITY, 'mcpDeviceSync');
  assert.deepEqual([...MCP_DEVICE_SYNC_OUTCOMES], ['added', 'updated', 'unchanged', 'removed', 'keptServerEntry', 'commandMissing', 'failed']);
  assert.equal(MCP_DEVICE_SYNC_LIMITS.bodyBytes, 256 * 1024);
  assert.equal(MCP_DEVICE_SYNC_LIMITS.servers, 32);
  assert.equal(MCP_DEVICE_SYNC_LIMITS.retain, 64);
  assert.equal(MCP_DEVICE_SYNC_LIMITS.results, 96);
  assert.equal(MCP_DEVICE_SYNC_LIMITS.cliRuns, 32);
});

test('a device sync request is parsed into a closed sorted model', () => {
  const parsed = parseMcpDeviceSyncRequest(request([
    { name: 'docs', launch: stdio({ env: { ZED: '1', ALPHA: '2' } }) },
    { name: 'web', launch: http({ headers: { 'X-B': 'b', 'X-A': 'a' } }) },
    { name: 'events', launch: { kind: 'sse', url: 'https://sse.example.com/', headers: {} } },
  ], ['keep_me']));
  assert.deepEqual(parsed, { servers: [
    { name: 'docs', launch: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: [['ALPHA', '2'], ['ZED', '1']] } },
    { name: 'web', launch: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: [['X-A', 'a'], ['X-B', 'b']] } },
    { name: 'events', launch: { kind: 'sse', url: 'https://sse.example.com/', headers: [] } },
  ], retain: ['keep_me'] });
  assert.deepEqual(parseMcpDeviceSyncRequest(request([], [])), { servers: [], retain: [] });
  const prototype = parseMcpDeviceSyncRequest(JSON.parse('{"version":1,"servers":[{"name":"p","launch":{"kind":"stdio","command":"x","args":[],"env":{"__proto__":"v"}}}],"retain":[]}'));
  assert.deepEqual(prototype.servers[0]!.launch, { kind: 'stdio', command: 'x', args: [], env: [['__proto__', 'v']] });
});

test('every malformed device sync shape is refused', () => {
  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null], ['array', []], ['empty', {}], ['version 2', request(undefined, undefined, { version: 2 })], ['version string', request(undefined, undefined, { version: '1' })],
    ['unknown envelope key', request(undefined, undefined, { extra: true })], ['missing retain', { version: 1, servers: [] }], ['missing servers', { version: 1, retain: [] }],
    ['servers object', request({} as unknown as unknown[])], ['retain string', { version: 1, servers: [], retain: 'docs' }],
    ['server unknown key', request([{ name: 'docs', launch: stdio(), scope: 'local' }])], ['server missing launch', request([{ name: 'docs' }])],
    ['invalid name', request([{ name: '-docs', launch: stdio() }])], ['long name', request([{ name: 'a'.repeat(65), launch: stdio() }])],
    ['name with dot', request([{ name: 'a.b', launch: stdio() }])], ['retain invalid name', request([], ['bad name'])],
    ['duplicate server', request([{ name: 'docs', launch: stdio() }, { name: 'docs', launch: http() }])],
    ['duplicate retain', request([], ['a', 'a'])], ['server also retained', request([{ name: 'docs', launch: stdio() }], ['docs'])],
    ['launch unknown kind', request([{ name: 'docs', launch: { kind: 'ws', url: 'wss://x' } }])],
    ['stdio unknown key', request([{ name: 'docs', launch: stdio({ cwd: '/' }) }])], ['stdio missing env', request([{ name: 'docs', launch: { kind: 'stdio', command: 'x', args: [] } }])],
    ['stdio missing args', request([{ name: 'docs', launch: { kind: 'stdio', command: 'x', env: {} } }])], ['stdio empty command', request([{ name: 'docs', launch: stdio({ command: '' }) }])],
    ['stdio control command', request([{ name: 'docs', launch: stdio({ command: 'a\nb' }) }])], ['stdio long command', request([{ name: 'docs', launch: stdio({ command: 'a'.repeat(1025) }) }])],
    ['too many args', request([{ name: 'docs', launch: stdio({ args: repeat(33, () => 'a') }) }])], ['long arg', request([{ name: 'docs', launch: stdio({ args: ['a'.repeat(1025)] }) }])],
    ['env array', request([{ name: 'docs', launch: stdio({ env: [] }) }])], ['env number value', request([{ name: 'docs', launch: stdio({ env: { K: 1 } }) }])],
    ['env key digit', request([{ name: 'docs', launch: stdio({ env: { '1K': 'v' } }) }])], ['env key dash', request([{ name: 'docs', launch: stdio({ env: { 'A-B': 'v' } }) }])],
    ['env key long', request([{ name: 'docs', launch: stdio({ env: { ['K'.repeat(129)]: 'v' } }) }])],
    ['env value NUL', request([{ name: 'docs', launch: stdio({ env: { K: 'a\u0000b' } }) }])], ['env value long', request([{ name: 'docs', launch: stdio({ env: { K: 'v'.repeat(8193) } }) }])],
    ['env value long multibyte', request([{ name: 'docs', launch: stdio({ env: { K: 'é'.repeat(4097) } }) }])],
    ['too many env', request([{ name: 'docs', launch: stdio({ env: Object.fromEntries(repeat(65, index => [`K${index}`, 'v'] as const)) }) }])],
    ['http unknown key', request([{ name: 'docs', launch: http({ oauth: {} }) }])], ['http missing headers', request([{ name: 'docs', launch: { kind: 'http', url: 'https://x.example.com' } }])],
    ['http bad url', request([{ name: 'docs', launch: http({ url: 'ftp://x.example.com' }) }])], ['http credentials url', request([{ name: 'docs', launch: http({ url: 'https://u:p@x.example.com' }) }])],
    ['header CR', request([{ name: 'docs', launch: http({ headers: { A: 'a\rb' } }) }])], ['header LF', request([{ name: 'docs', launch: http({ headers: { A: 'a\nb' } }) }])],
    ['header NUL', request([{ name: 'docs', launch: http({ headers: { A: 'a\u0000b' } }) }])], ['header name space', request([{ name: 'docs', launch: http({ headers: { 'A B': 'v' } }) }])],
    ['header name colon', request([{ name: 'docs', launch: http({ headers: { 'A:': 'v' } }) }])], ['header name long', request([{ name: 'docs', launch: http({ headers: { ['h'.repeat(129)]: 'v' } }) }])],
    ['header value long', request([{ name: 'docs', launch: http({ headers: { A: 'v'.repeat(8193) } }) }])],
    ['header duplicate case', request([{ name: 'docs', launch: http({ headers: { Accept: 'a', accept: 'b' } }) }])],
    ['too many headers', request([{ name: 'docs', launch: http({ headers: Object.fromEntries(repeat(33, index => [`H${index}`, 'v'] as const)) }) }])],
    ['too many servers', request(repeat(33, index => ({ name: `s${index}`, launch: stdio() })))], ['too much retain', request([], repeat(65, index => `r${index}`))],
  ];
  for (const [label, value] of shapes) rejects(value, label);
  assert.equal(parseMcpDeviceSyncRequest(request(repeat(32, index => ({ name: `s${index}`, launch: stdio() })), repeat(64, index => `r${index}`))).servers.length, 32);
  assert.equal(parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: stdio({ env: Object.fromEntries(repeat(64, index => [`K${index}`, 'v'.repeat(256)] as const)) }) }])).servers.length, 1);
  assert.equal(parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: stdio({ env: { K: 'v'.repeat(8192) } }) }])).servers.length, 1);
  assert.equal(parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: http({ headers: Object.fromEntries(repeat(32, index => [`H${index}`, 'v'.repeat(256)] as const)) }) }])).servers.length, 1);
  assert.equal(parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: http({ headers: { A: 'v'.repeat(8192) } }) }])).servers.length, 1);
});

test('a parse failure never echoes the secret values it rejected', () => {
  try {
    parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: http({ headers: { A: `${SECRET}\r\n` } }) }]));
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(!String((error as Error).message).includes(SECRET));
    assert.ok(!JSON.stringify(error).includes(SECRET));
  }
});

test('Claude stored entries are normalized so equal configs share a digest', () => {
  assert.deepEqual(parseClaudeStoredServer({ command: 'npx' }), stored({ kind: 'stdio', command: 'npx', args: [], env: [] }));
  assert.deepEqual(parseClaudeStoredServer({ type: 'stdio', command: 'npx', args: ['a'], env: { K: 'V' } }), stored(launchA));
  assert.deepEqual(parseClaudeStoredServer({ type: 'http', url: 'https://c.example.com/mcp' }), stored(remoteC));
  assert.deepEqual(parseClaudeStoredServer({ type: 'sse', url: 'https://c.example.com/mcp', headers: { B: '2', A: '1' } }),
    stored({ kind: 'sse', url: 'https://c.example.com/mcp', headers: [['A', '1'], ['B', '2']] }));
  for (const value of [null, [], 'x', { type: 'ws', url: 'wss://x' }, { type: 'sdk' }, { type: 'claudeai-proxy', url: 'https://x' }, { command: 1 },
    { command: 'x', args: 'a' }, { command: 'x', env: { K: 1 } }, { command: 'x', timeout: 5 }, { type: 'http', url: 'https://x', oauth: {} },
    { type: 'http', url: 'https://x', headersHelper: 'h' }, { type: 'http' }]) assert.deepEqual(parseClaudeStoredServer(value), unrecognized, JSON.stringify(value));
  const fromRequest = parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: { kind: 'stdio', command: 'npx', args: [], env: {} } }])).servers[0]!.launch;
  assert.equal(mcpDeviceLaunchDigest(fromRequest), mcpDeviceLaunchDigest((parseClaudeStoredServer({ command: 'npx' }) as { launch: McpDeviceLaunch }).launch));
  assert.match(digestA, /^[0-9a-f]{64}$/);
  assert.notEqual(digestA, digestB);
  assert.notEqual(mcpDeviceLaunchDigest({ kind: 'http', url: 'https://c.example.com/mcp', headers: [] }), mcpDeviceLaunchDigest({ kind: 'sse', url: 'https://c.example.com/mcp', headers: [] }));
  assert.equal(mcpDeviceLaunchDigest({ kind: 'stdio', command: 'a', args: ['b', 'c'], env: [] }) === mcpDeviceLaunchDigest({ kind: 'stdio', command: 'a', args: ['b,c'], env: [] }), false);
});

test('the add-json payload is the explicit normalized Claude entry', () => {
  assert.equal(claudeMcpJson(launchA), '{"type":"stdio","command":"npx","args":["a"],"env":{"K":"V"}}');
  assert.equal(claudeMcpJson(remoteC), '{"type":"http","url":"https://c.example.com/mcp","headers":{}}');
  const json = claudeMcpJson({ kind: 'stdio', command: 'x', args: [], env: [['__proto__', 'v']] });
  assert.equal(json, '{"type":"stdio","command":"x","args":[],"env":{"__proto__":"v"}}');
  assert.deepEqual(parseClaudeStoredServer(JSON.parse(json)), stored({ kind: 'stdio', command: 'x', args: [], env: [['__proto__', 'v']] }));
});

test('the add-json plan passes the name and JSON as argv after an option terminator', () => {
  const plan = claudeMcpAddJsonPlan('--scope', '{"type":"stdio","command":"x"}');
  assert.deepEqual(plan.args, ['mcp', 'add-json', '--scope', 'local', '--', '--scope', '{"type":"stdio","command":"x"}']);
  assert.equal(plan.outcome(0, ''), 'ok');
  assert.equal(plan.outcome(1, 'MCP server --scope already exists in local config'), 'exists');
  assert.equal(plan.outcome(1, 'something else'), 'failed');
  assert.equal(plan.outcome(null, ''), 'failed');
});

test('the server local config is looked up by the exact project key', () => {
  const config = { mcpServers: { userScope: { command: 'u' } }, projects: {
    '/srv/app': { mcpServers: { docs: { command: 'npx', args: ['a'], env: { K: 'V' } }, odd: { type: 'ws', url: 'wss://x' }, other: { command: 'o' } } },
    '/srv/app/sub': { mcpServers: { nested: { command: 'n' } } },
  } };
  const found = claudeLocalServers(config, '/srv/app', ['docs', 'odd', 'missing', 'userScope', 'nested']);
  assert.deepEqual([...found.keys()], ['docs', 'odd']);
  assert.deepEqual(found.get('docs'), stored(launchA));
  assert.deepEqual(found.get('odd'), unrecognized);
  assert.equal(claudeLocalServers(config, '/srv/app/', ['docs']).size, 0);
  assert.equal(claudeLocalServers(config, '/srv', ['docs']).size, 0);
  assert.equal(claudeLocalServers({}, '/srv/app', ['docs']).size, 0);
  assert.equal(claudeLocalServers({ projects: { '/srv/app': {} } }, '/srv/app', ['docs']).size, 0);
  assert.equal(claudeLocalServers({ projects: { '/srv/app': { mcpServers: [] } } }, '/srv/app', ['docs']).size, 0);
  assert.equal(claudeLocalServers(JSON.parse('{"projects":{"/srv/app":{"mcpServers":{}}}}'), '/srv/app', ['__proto__', 'constructor']).size, 0);
  assert.throws(() => claudeLocalServers([], '/srv/app', ['docs']), { name: 'RunnerError', code: 'storage_unavailable' });
  assert.throws(() => claudeLocalServers('x', '/srv/app', ['docs']), { name: 'RunnerError', code: 'storage_unavailable' });
});

test('the ledger keeps only names and digests and refuses every corrupt shape', () => {
  const servers = new Map([['zeta', digestB], ['alpha', digestA]]);
  const text = serializeMcpDeviceSyncLedger(servers);
  assert.equal(text, JSON.stringify({ version: 1, servers: [{ name: 'alpha', digest: digestA }, { name: 'zeta', digest: digestB }] }));
  assert.deepEqual(parseMcpDeviceSyncLedger(JSON.parse(text)), { kind: 'valid', servers: new Map([['alpha', digestA], ['zeta', digestB]]) });
  for (const value of [null, [], {}, { version: 2, servers: [] }, { version: 1, servers: {} }, { version: 1, servers: [], extra: 1 },
    { version: 1, servers: [{ name: 'a' }] }, { version: 1, servers: [{ name: 'a', digest: 'x' }] }, { version: 1, servers: [{ name: 'a b', digest: digestA }] },
    { version: 1, servers: [{ name: 'a', digest: digestA, value: SECRET }] }, { version: 1, servers: [{ name: 'a', digest: digestA }, { name: 'a', digest: digestB }] },
    { version: 1, servers: repeat(97, index => ({ name: `s${index}`, digest: digestA })) }]) assert.deepEqual(parseMcpDeviceSyncLedger(value), { kind: 'corrupt' }, JSON.stringify(value));
  assert.equal(sameMcpDeviceSyncLedger({ kind: 'valid', servers }, new Map(servers)), true);
  assert.equal(sameMcpDeviceSyncLedger({ kind: 'valid', servers }, new Map([['alpha', digestA]])), false);
  assert.equal(sameMcpDeviceSyncLedger({ kind: 'valid', servers }, new Map([['alpha', digestB], ['zeta', digestB]])), false);
  assert.equal(sameMcpDeviceSyncLedger(corrupt, new Map()), false);
  assert.deepEqual([...mcpDeviceSyncNames({ servers: [server('a', launchA)], retain: ['r'] }, ledgerOf({ l: launchB }))], ['a', 'r', 'l']);
  assert.deepEqual([...mcpDeviceSyncNames({ servers: [], retain: [] }, corrupt)], []);
});

type Row = Readonly<{
  label: string; desired?: readonly McpDeviceServer[]; retain?: readonly string[]; current?: Readonly<Record<string, ClaudeStoredServer>>;
  ledger?: McpDeviceSyncLedger; missing?: readonly string[];
  outcomes: Readonly<Record<string, string>>; steps: readonly string[]; settled: Readonly<Record<string, string>>;
}>;
const describeStep = (step: { kind: string; name: string }) => `${step.kind}:${step.name}`;
const ROWS: readonly Row[] = [
  { label: 'missing on server is added', desired: [server('a', launchA)], outcomes: { a: 'added' }, steps: ['add:a'], settled: { a: digestA } },
  { label: 'equal is unchanged and becomes managed', desired: [server('a', launchA)], current: { a: stored(launchA) }, outcomes: { a: 'unchanged' }, steps: [], settled: { a: digestA } },
  { label: 'equal with a corrupt ledger is still managed afterwards', desired: [server('a', launchA)], current: { a: stored(launchA) }, ledger: corrupt,
    outcomes: { a: 'unchanged' }, steps: [], settled: { a: digestA } },
  { label: 'managed and unedited is updated', desired: [server('a', launchB)], current: { a: stored(launchA) }, ledger: ledgerOf({ a: launchA }),
    outcomes: { a: 'updated' }, steps: ['remove:a', 'add:a'], settled: { a: digestB } },
  { label: 'server-owned differing entry is kept', desired: [server('a', launchB)], current: { a: stored(launchA) }, outcomes: { a: 'keptServerEntry' }, steps: [], settled: {} },
  { label: 'managed but edited on the server is kept and forgotten', desired: [server('a', launchB)], current: { a: stored(remoteC) }, ledger: ledgerOf({ a: launchA }),
    outcomes: { a: 'keptServerEntry' }, steps: [], settled: {} },
  { label: 'unrecognized server entry is kept', desired: [server('a', launchB)], current: { a: unrecognized }, ledger: ledgerOf({ a: launchA }),
    outcomes: { a: 'keptServerEntry' }, steps: [], settled: {} },
  { label: 'differing entry with a corrupt ledger is kept', desired: [server('a', launchB)], current: { a: stored(launchA) }, ledger: corrupt,
    outcomes: { a: 'keptServerEntry' }, steps: [], settled: {} },
  { label: 'missing command is not installed', desired: [server('a', launchA)], missing: ['a'], outcomes: { a: 'commandMissing' }, steps: [], settled: {} },
  { label: 'missing command keeps a managed entry managed', desired: [server('a', launchB)], current: { a: stored(launchA) }, ledger: ledgerOf({ a: launchA }), missing: ['a'],
    outcomes: { a: 'commandMissing' }, steps: [], settled: { a: digestA } },
  { label: 'missing command does not hide an equal entry', desired: [server('a', launchA)], current: { a: stored(launchA) }, missing: ['a'], outcomes: { a: 'unchanged' }, steps: [], settled: { a: digestA } },
  { label: 'managed absent from request is removed', current: { a: stored(launchA) }, ledger: ledgerOf({ a: launchA }), outcomes: { a: 'removed' }, steps: ['remove:a'], settled: {} },
  { label: 'managed absent but edited is kept', current: { a: stored(launchB) }, ledger: ledgerOf({ a: launchA }), outcomes: { a: 'keptServerEntry' }, steps: [], settled: {} },
  { label: 'managed absent everywhere is silently forgotten', ledger: ledgerOf({ a: launchA }), outcomes: {}, steps: [], settled: {} },
  { label: 'retained managed entry is left alone and stays managed', retain: ['a'], current: { a: stored(launchA) }, ledger: ledgerOf({ a: launchA }), outcomes: {}, steps: [], settled: { a: digestA } },
  { label: 'retained name not on the server is left alone', retain: ['a'], ledger: ledgerOf({ a: launchA }), outcomes: {}, steps: [], settled: {} },
  { label: 'server-owned entry outside the request is never touched', current: { own: stored(launchA) }, outcomes: {}, steps: [], settled: {} },
  { label: 'a corrupt ledger removes nothing', current: { a: stored(launchA) }, ledger: corrupt, outcomes: {}, steps: [], settled: {} },
  { label: 'mixed request keeps request order then sorted ledger names',
    desired: [server('z', launchA), server('b', launchB), server('c', remoteC)], current: { b: stored(launchB), old2: stored(launchA), old1: stored(launchB), own: stored(launchA) },
    ledger: ledgerOf({ old2: launchA, old1: launchA }),
    outcomes: { z: 'added', b: 'unchanged', c: 'added', old1: 'keptServerEntry', old2: 'removed' }, steps: ['add:z', 'add:c', 'remove:old2'],
    settled: { z: digestA, b: digestB, c: digestC } },
];

for (const row of ROWS) {
  test(`device sync planner: ${row.label}`, () => {
    const current = new Map(Object.entries(row.current ?? {}));
    const plan = planDeviceSync(row.desired ?? [], row.retain ?? [], current, row.ledger ?? EMPTY_MCP_DEVICE_SYNC_LEDGER, new Set(row.missing ?? []));
    assert.deepEqual(Object.fromEntries(plan.items.filter(item => item.outcome !== null).map(item => [item.name, item.outcome])), row.outcomes);
    assert.deepEqual(plan.items.flatMap(item => item.steps.map(describeStep)), row.steps);
    const final = new Map(current);
    for (const step of plan.items.flatMap(item => item.steps)) {
      if (step.kind === 'remove') final.delete(step.name);
      if (step.kind === 'add') final.set(step.name, parseClaudeStoredServer(JSON.parse(step.json)));
    }
    const settled = settleDeviceSync(plan, applied(...plan.items.filter(item => item.steps.length > 0).map(item => item.name)), final);
    assert.deepEqual(Object.fromEntries(settled.ledger), row.settled);
    assert.deepEqual(Object.fromEntries(settled.report.results.map(result => [result.name, result.outcome])), row.outcomes);
    assert.deepEqual(settled.report.results.map(result => result.name), Object.keys(row.outcomes));
  });
}

test('settlement reports failed when a step failed or the entry is not under the expected key', () => {
  const plan = planDeviceSync([server('a', launchA), server('b', launchB), server('u', launchB)], [], new Map([['u', stored(launchA)]]), ledgerOf({ u: launchA, gone: launchA }));
  const withGone = planDeviceSync([server('a', launchA)], [], new Map([['gone', stored(launchA)]]), ledgerOf({ gone: launchA }));
  assert.deepEqual(plan.items.map(item => item.outcome), ['added', 'added', 'updated', null]);
  const failedAll = settleDeviceSync(plan, applied(), new Map([['u', stored(launchA)]]));
  assert.deepEqual(failedAll.report.results.map(result => result.outcome), ['failed', 'failed', 'failed']);
  assert.deepEqual(Object.fromEntries(failedAll.ledger), { u: digestA });
  const notStored = settleDeviceSync(plan, applied('a', 'b', 'u'), new Map([['a', stored(launchB)]]));
  assert.deepEqual(notStored.report.results.map(result => result.outcome), ['failed', 'failed', 'failed']);
  assert.deepEqual(Object.fromEntries(notStored.ledger), {});
  const removalFailed = settleDeviceSync(withGone, applied('a'), new Map([['a', stored(launchA)], ['gone', stored(launchA)]]));
  assert.deepEqual(removalFailed.report.results, [{ name: 'a', outcome: 'added' }, { name: 'gone', outcome: 'failed' }]);
  assert.deepEqual(Object.fromEntries(removalFailed.ledger), { a: digestA, gone: digestA });
  const editedMeanwhile = settleDeviceSync(planDeviceSync([server('a', launchA)], [], new Map([['a', stored(launchA)]]), EMPTY_MCP_DEVICE_SYNC_LEDGER), applied(), new Map([['a', stored(launchB)]]));
  assert.deepEqual(editedMeanwhile.report.results, [{ name: 'a', outcome: 'unchanged' }]);
  assert.equal(editedMeanwhile.ledger.size, 0);
});

test('the planner never schedules more than 32 CLI runs or reports more than 96 names', () => {
  const desired = repeat(32, index => server(`s${index}`, launchB));
  const current = new Map(desired.map(entry => [entry.name, stored(launchA)] as const));
  const ledger: McpDeviceSyncLedger = { kind: 'valid', servers: new Map(desired.map(entry => [entry.name, digestA])) };
  const plan = planDeviceSync(desired, [], current, ledger);
  assert.equal(plan.items.reduce((total, item) => total + item.steps.length, 0), 32);
  assert.equal(plan.items.filter(item => item.outcome === 'updated').length, 16);
  assert.equal(plan.items.filter(item => item.outcome === 'failed').length, 16);
  const settled = settleDeviceSync(plan, applied(), current);
  assert.equal(settled.ledger.size, 32);
  const stale = repeat(96, index => `old${String(index).padStart(2, '0')}`);
  const wide = planDeviceSync(desired.map(entry => server(entry.name, launchA)), [], new Map([...current, ...stale.map(name => [name, stored(launchA)] as const)]),
    { kind: 'valid', servers: new Map(stale.map(name => [name, digestA])) });
  assert.equal(wide.items.filter(item => item.outcome !== null).length, 96);
  assert.equal(wide.items.reduce((total, item) => total + item.steps.length, 0), 32);
  const wideSettled = settleDeviceSync(wide, applied(), new Map([...current, ...stale.map(name => [name, stored(launchA)] as const)]));
  assert.equal(wideSettled.report.results.length, 96);
  assert.equal(wideSettled.ledger.size, MCP_DEVICE_SYNC_LIMITS.ledgerEntries);
  assert.equal(stale.every(name => wideSettled.ledger.get(name) === digestA), true);
  assert.equal(desired.some(entry => wideSettled.ledger.has(entry.name)), false);
  assert.deepEqual(parseMcpDeviceSyncLedger(JSON.parse(serializeMcpDeviceSyncLedger(wideSettled.ledger))), { kind: 'valid', servers: wideSettled.ledger });
  assert.throws(() => serializeMcpDeviceSyncLedger(new Map(repeat(97, index => [`s${index}`, digestA] as const))), { name: 'RunnerError', code: 'storage_unavailable' });
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test('every settled ledger stays within the reader limit, keeps every still-matching managed name and parses back unchanged', () => {
  const launches = [launchA, launchB, remoteC];
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const pool = repeat(160, index => `n${index}`);
    const desired = pool.slice(0, Math.floor(next() * 33)).map(name => server(name, pick(launches)));
    const rest = pool.slice(desired.length);
    const retain = rest.filter(() => next() < 0.3).slice(0, 64);
    const ledgerNames = [...pool].filter(() => next() < 0.7).slice(0, 96);
    const ledger: McpDeviceSyncLedger = next() < 0.1 ? corrupt : { kind: 'valid', servers: new Map(ledgerNames.map(name => [name, mcpDeviceLaunchDigest(pick(launches))])) };
    const current = new Map(pool.filter(() => next() < 0.8).map(name => [name, next() < 0.1 ? unrecognized : stored(pick(launches))] as const));
    const missing = new Set(desired.filter(() => next() < 0.2).map(entry => entry.name));
    const plan = planDeviceSync(desired, retain, current, ledger, missing);
    assert.ok(plan.items.reduce((total, item) => total + item.steps.length, 0) <= MCP_DEVICE_SYNC_LIMITS.cliRuns, `seed ${seed}`);
    const final = new Map(current);
    const progress = new Map<string, McpDeviceSyncProgress>();
    for (const item of plan.items) {
      if (item.steps.length === 0 || next() < 0.15) continue;
      const first = item.steps[0]!;
      if (first.kind === 'remove' && next() < 0.15) {
        final.set(item.name, stored({ kind: 'stdio', command: `operator-${seed}`, args: [], env: [] }));
        progress.set(item.name, 'diverged');
        continue;
      }
      for (const step of item.steps) {
        if (step.kind === 'remove') final.delete(step.name);
        if (step.kind === 'add') final.set(step.name, parseClaudeStoredServer(JSON.parse(step.json)));
      }
      progress.set(item.name, 'applied');
    }
    const settled = settleDeviceSync(plan, progress, final);
    if (ledger.kind === 'valid') {
      for (const [name, digest] of ledger.servers)
        if (storedDigest(final.get(name)) === digest) assert.ok(settled.ledger.has(name), `seed ${seed}: managed ${name} dropped`);
    }
    assert.ok(settled.ledger.size <= MCP_DEVICE_SYNC_LIMITS.ledgerEntries, `seed ${seed}`);
    assert.ok(settled.report.results.length <= MCP_DEVICE_SYNC_LIMITS.results, `seed ${seed}`);
    assert.deepEqual(parseMcpDeviceSyncLedger(JSON.parse(serializeMcpDeviceSyncLedger(settled.ledger))), { kind: 'valid', servers: settled.ledger }, `seed ${seed}`);
  }
});

test('a diverged removal is reported as a kept server entry and forgotten', () => {
  const plan = planDeviceSync([server('a', launchB)], [], new Map([['a', stored(launchA)], ['old', stored(launchA)]]), ledgerOf({ a: launchA, old: launchA }));
  assert.deepEqual(plan.items.map(item => item.steps.map(describeStep)), [['remove:a', 'add:a'], ['remove:old']]);
  assert.deepEqual(plan.items[0]!.steps[0], { kind: 'remove', name: 'a', digest: digestA });
  const settled = settleDeviceSync(plan, new Map([['a', 'diverged'], ['old', 'diverged']]), new Map([['a', stored(remoteC)], ['old', stored(launchA)]]));
  assert.deepEqual(settled.report.results, [{ name: 'a', outcome: 'keptServerEntry' }, { name: 'old', outcome: 'keptServerEntry' }]);
  assert.equal(settled.ledger.size, 0);
});

test('an add-json argument above 32,768 bytes is accepted by the parser but never planned', () => {
  assert.equal(MCP_DEVICE_SYNC_LIMITS.addJsonBytes, 32_768);
  const env = (count: number, size: number) => Object.fromEntries(repeat(count, index => [`K${index}`, 'v'.repeat(size)] as const));
  const big = parseMcpDeviceSyncRequest(request([{ name: 'big', launch: stdio({ env: env(4, 8192) }) }, { name: 'small', launch: stdio() }]));
  assert.equal(isLaunchableMcpDeviceLaunch(big.servers[0]!.launch), false);
  assert.deepEqual(planDeviceSync(big.servers, [], new Map(), EMPTY_MCP_DEVICE_SYNC_LEDGER).items.map(item => [item.name, item.outcome, item.steps.map(describeStep)]),
    [['big', 'failed', []], ['small', 'added', ['add:small']]]);
  const base = parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: stdio({ env: { K0: '' } }) }])).servers[0]!.launch;
  const room = 32_768 - Buffer.byteLength(claudeMcpJson(base));
  const fits = { K0: 'v'.repeat(8192), K1: 'v'.repeat(8192), K2: 'v'.repeat(8192), K3: 'v'.repeat(room - 3 * 8192 - 3 * '"K1":"",'.length) };
  const parsedFit = parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: stdio({ env: fits }) }])).servers[0]!.launch;
  assert.equal(Buffer.byteLength(claudeMcpJson(parsedFit)), 32_768);
  assert.equal(isLaunchableMcpDeviceLaunch(parsedFit), true);
  const launchable = (changed: Readonly<Record<string, string>>) =>
    isLaunchableMcpDeviceLaunch(parseMcpDeviceSyncRequest(request([{ name: 'docs', launch: stdio({ env: { ...fits, ...changed } }) }])).servers[0]!.launch);
  assert.equal(launchable({ K3: `${fits.K3}v` }), false);
  assert.equal(launchable({ K3: `${fits.K3.slice(1)}\n` }), false);
  assert.equal(launchable({ K3: `${fits.K3.slice(1)}é` }), false);
  const oversized: McpDeviceLaunch = { kind: 'stdio', command: 'npx', args: [], env: repeat(5, index => [`K${index}`, 'v'.repeat(8192)] as const) };
  const plan = planDeviceSync([server('a', oversized), server('b', oversized)], [], new Map([['a', stored(launchA)]]), ledgerOf({ a: launchA }));
  assert.deepEqual(plan.items.map(item => [item.outcome, item.steps.length]), [['failed', 0], ['failed', 0]]);
  const settled = settleDeviceSync(plan, applied(), new Map([['a', stored(launchA)]]));
  assert.deepEqual(Object.fromEntries(settled.ledger), { a: digestA });
});

test('a full ledger never forgets a managed name to make room for new ones', () => {
  const old = repeat(96, index => `old${String(index).padStart(2, '0')}`);
  const current = new Map(old.map(name => [name, stored(launchA)] as const));
  const ledger: McpDeviceSyncLedger = { kind: 'valid', servers: new Map(old.map(name => [name, digestA])) };
  const plan = planDeviceSync(repeat(32, index => server(`new${index}`, launchB)), old.slice(0, 64), current, ledger);
  assert.deepEqual(plan.items.slice(0, 32).map(item => [item.outcome, item.steps.length]), repeat(32, () => ['failed', 0]));
  const settled = settleDeviceSync(plan, applied(), current);
  assert.deepEqual([...settled.ledger.keys()].sort(), old);
  const adoption = planDeviceSync([server('old00', launchA), server('fresh', launchA)], old, new Map([...current, ['fresh', stored(launchA)]]), ledger);
  assert.deepEqual(adoption.items.slice(0, 2).map(item => [item.outcome, item.ledger]), [['unchanged', digestA], ['unchanged', null]]);
  const room: McpDeviceSyncLedger = { kind: 'valid', servers: new Map(old.slice(1).map(name => [name, digestA])) };
  const one = planDeviceSync([server('a', launchB), server('b', launchB)], [], current, room);
  assert.deepEqual(one.items.slice(0, 2).map(item => [item.name, item.outcome]), [['a', 'added'], ['b', 'failed']]);
  const gone = planDeviceSync([server('a', launchB)], [], new Map([...current].slice(1)), ledger);
  assert.deepEqual(gone.items.slice(0, 1).map(item => item.outcome), ['added']);
});

test('preapproval covers only ledger names whose server copy still matches', () => {
  const ledger = ledgerOf({ zeta: launchA, alpha: launchB, edited: launchA, gone: launchA });
  const current = new Map([['zeta', stored(launchA)], ['alpha', stored(launchB)], ['edited', stored(launchB)], ['own', stored(launchA)]]);
  assert.deepEqual(preapprovedMcpServers(ledger, current), ['alpha', 'zeta']);
  assert.deepEqual(preapprovedMcpServers(corrupt, current), []);
  assert.deepEqual(preapprovedMcpServers(EMPTY_MCP_DEVICE_SYNC_LEDGER, current), []);
});

test('preapproved MCP servers widen only --allowedTools in non-bypass Claude modes', () => {
  const runnerDefault = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash'];
  assert.deepEqual(withMcpServerPreapproval(runnerDefault, undefined, ['docs', 'web']),
    ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash,mcp__docs,mcp__web']);
  assert.deepEqual(runnerDefault[3], 'Read,Write,Edit,Glob,Grep,Bash');
  const claude = (mode: string) => ({ provider: 'claudeCode', model: 'opus', mode, effort: 'high' }) as Parameters<typeof withMcpServerPreapproval>[1];
  for (const mode of ['default', 'plan', 'supervised', 'acceptEdits', 'auto']) {
    const base = mode === 'default' ? ['--model', 'opus'] : ['--model', 'opus', '--permission-mode', mode];
    assert.deepEqual(withMcpServerPreapproval(base, claude(mode), ['docs']), [...base, '--allowedTools', 'mcp__docs'], mode);
  }
  assert.deepEqual(withMcpServerPreapproval(['--dangerously-skip-permissions'], claude('bypassPermissions'), ['docs']), ['--dangerously-skip-permissions']);
  assert.deepEqual(withMcpServerPreapproval(runnerDefault, undefined, []), runnerDefault);
  assert.deepEqual(withMcpServerPreapproval(['--model', 'opus'], claude('plan'), ['docs', 'docs', 'bad name', '--allowedTools', 'Bash']),
    ['--model', 'opus', '--allowedTools', 'mcp__docs,mcp__Bash']);
  assert.deepEqual(withMcpServerPreapproval(['--model', 'opus'], claude('plan'), repeat(100, index => `s${index}`)).at(-1)!.split(',').length, 96);
  assert.deepEqual(withMcpServerPreapproval(runnerDefault, undefined, ['github__delete_repository', '_hidden', 'a__b', 'docs', 'my_server', 'tail_', 'dash-name']),
    ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash,mcp__docs,mcp__my_server,mcp__tail_,mcp__dash-name']);
  assert.deepEqual(withMcpServerPreapproval(['--model', 'opus'], claude('plan'), ['github__delete_repository']), ['--model', 'opus']);
  const synced = parseMcpDeviceSyncRequest(request([{ name: 'github__delete_repository', launch: stdio() }]));
  assert.deepEqual(planDeviceSync(synced.servers, [], new Map(), EMPTY_MCP_DEVICE_SYNC_LEDGER).items.map(item => [item.name, item.outcome]), [['github__delete_repository', 'added']]);
  for (const name of ['docs', 'my_server', 'tail_', 'dash-name', 'A1']) assert.equal(isPreapprovableMcpServerName(name), true, name);
  for (const name of ['github__delete_repository', 'a__b', '__x', '_hidden', 'x*', 'a b', 'a:b', 'a,b', 'a(b)', '']) assert.equal(isPreapprovableMcpServerName(name), false, name);
});
