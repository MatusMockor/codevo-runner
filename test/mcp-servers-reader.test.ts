import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { validateMcpServers } from '../src/domain/mcp-servers.js';
import { CliMcpServersReader, MCP_SERVERS_PROBE_BYTES, MCP_SERVERS_PROBE_TIMEOUT_MS } from '../src/infrastructure/execution/mcp-servers.js';
import {
  CLAUDE_INITIALIZE_LINE, CLAUDE_MCP_ARGS, CODEX_INITIALIZE_LINE, MARKER, assertTreeReaped, claudeScript, claudeServersWithSecrets, claudeSnapshotWithoutSecrets,
  claudeStatusLine, codexConfigWithSecrets, codexScript, codexSnapshotWithoutConfig, codexSnapshotWithoutSecrets, codexStatusWithSecrets, hangingScript, lines, readPid,
  shellFixture, writeJson, type ShellFake,
} from './mcp-servers-fixture.js';

const MIB = 1024 * 1024;
const FAST = { pollMs: 10, stableMs: 150, settleMs: 5_000 };
const SLACK_MS = 7_000;
const ALLOWED_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'PWD', 'OLDPWD', 'SHLVL', '_'];
const open = () => new AbortController().signal;
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
const unavailable = { message: 'usage_unavailable' };

async function workspace(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-servers-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const info = await lstat(cwd);
  const workdir: McpServersWorkdir = { cwd, identity: { dev: info.dev, ino: info.ino } };
  return { root, workdir };
}
async function environment(root: string): Promise<ReadonlyMap<string, string>> {
  return new Map((await lines(root, 'env')).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
}
async function scenario(t: TestContext, name: string, script: (root: string) => string) {
  const { root, workdir } = await workspace(t);
  return { root, workdir, executable: await shellFixture(root, name, script(root)) };
}

test('probe limits match the reference', () => {
  assert.equal(MCP_SERVERS_PROBE_TIMEOUT_MS, 25_000);
  assert.deepEqual(MCP_SERVERS_PROBE_BYTES, { claude: { outputBytes: 16 * MIB, lineBytes: 2 * MIB }, codex: { outputBytes: 16 * MIB, lineBytes: 8 * MIB } });
});

test('Claude probe runs in the pinned project directory, sends only the constant control requests and is terminated on completion', async t => {
  const { root, workdir, executable } = await scenario(t, 'claude', root => claudeScript(root));
  const baseline = timers();
  await writeJson(root, 'servers-1.json', { mcpServers: [] });
  await writeJson(root, 'servers-2.json', { mcpServers: [{ name: 'claude.ai Gmail', status: 'pending', scope: 'claudeai' }] });
  await writeJson(root, 'servers.json', { mcpServers: claudeServersWithSecrets, account: { email: `${MARKER}@example.invalid` } });
  process.env.CODEVO_MCP_TEST_SECRET = MARKER;
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  t.after(() => { delete process.env.CODEVO_MCP_TEST_SECRET; delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS; });
  const started = Date.now();
  const snapshot = await new CliMcpServersReader({ claudeExecutable: executable, timing: FAST }).read('claude', workdir, open());
  assert.ok(Date.now() - started >= FAST.stableMs && Date.now() - started < SLACK_MS);
  assert.deepEqual(validateMcpServers(snapshot), claudeSnapshotWithoutSecrets);
  assert.equal(JSON.stringify(snapshot).includes(MARKER), false);
  assert.equal(JSON.stringify(snapshot).includes('4242'), false);
  await assertTreeReaped(root);
  assert.equal(timers(), baseline);

  assert.deepEqual(await lines(root, 'launches'), ['launch']);
  assert.deepEqual(await lines(root, 'cwd'), [workdir.cwd]);
  assert.deepEqual(await lines(root, 'args'), CLAUDE_MCP_ARGS);
  assert.equal((await lines(root, 'args')).includes('--strict-mcp-config'), false);
  const env = await environment(root);
  assert.deepEqual([env.get('CLAUDE_CODE_AUTO_CONNECT_IDE'), env.get('CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL')], ['0', '1']);
  assert.deepEqual([env.has('ENABLE_CLAUDEAI_MCP_SERVERS'), env.has('CODEVO_MCP_TEST_SECRET'), env.has('PATH')], [false, false, true]);
  assert.deepEqual([...env.keys()].filter(key => ![...ALLOWED_ENVIRONMENT, 'CLAUDE_CODE_AUTO_CONNECT_IDE', 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL'].includes(key)), []);
  const stdin = await lines(root, 'stdin');
  assert.ok(stdin.length >= 5, String(stdin.length));
  assert.deepEqual(stdin, [CLAUDE_INITIALIZE_LINE, ...stdin.slice(1).map((_, index) => claudeStatusLine(index + 1))]);
  assert.equal(stdin.some(entry => entry.includes('"user"') || entry.includes(root)), false);
});

test('Codex probe completes the handshake, lists status once, then reads the effective config and is terminated on completion', async t => {
  const { root, workdir, executable } = await scenario(t, 'codex', root => codexScript(root));
  const baseline = timers();
  await writeJson(root, 'config.json', codexConfigWithSecrets);
  await writeJson(root, 'status.json', codexStatusWithSecrets);
  const snapshot = await new CliMcpServersReader({ codexExecutable: executable }).read('codex', workdir, open());
  assert.deepEqual(validateMcpServers(snapshot), codexSnapshotWithoutSecrets);
  assert.equal(JSON.stringify(snapshot).includes(MARKER), false);
  await assertTreeReaped(root);
  assert.equal(timers(), baseline);

  assert.deepEqual(await lines(root, 'launches'), ['launch']);
  assert.deepEqual(await lines(root, 'cwd'), [workdir.cwd]);
  assert.deepEqual(await lines(root, 'args'), ['app-server', '--stdio']);
  const env = await environment(root);
  assert.deepEqual([...env.keys()].filter(key => !ALLOWED_ENVIRONMENT.includes(key)), []);
  assert.deepEqual(await lines(root, 'stdin'), [CODEX_INITIALIZE_LINE, '{"method":"initialized","params":{}}',
    '{"id":1,"method":"mcpServerStatus/list","params":{"detail":"toolsAndAuthOnly","limit":128}}',
    JSON.stringify({ id: 2, method: 'config/read', params: { cwd: workdir.cwd, includeLayers: false } })]);

  await writeJson(root, 'status.json', { ...codexStatusWithSecrets, nextCursor: '128' });
  const paged = await new CliMcpServersReader({ codexExecutable: executable }).read('codex', workdir, open());
  assert.deepEqual(paged, { ...codexSnapshotWithoutSecrets, truncated: true });
  await assertTreeReaped(root);
});

test('Claude returns the latest snapshot with connecting servers at the settle deadline and at the process timeout', async t => {
  const { root, workdir, executable } = await scenario(t, 'claude', root => claudeScript(root));
  await writeJson(root, 'servers.json', { mcpServers: [{ name: 'slow', status: 'pending', scope: 'project' }, { name: 'ready', status: 'connected', scope: 'user' }] });
  const expected = { version: 1, provider: 'claude', truncated: false, servers: [
    { name: 'ready', status: 'connected', scope: 'user', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null },
    { name: 'slow', status: 'connecting', scope: 'project', transport: 'stdio', endpointOrigin: null, toolCount: null, detail: null },
  ] };
  let started = Date.now();
  assert.deepEqual(await new CliMcpServersReader({ claudeExecutable: executable, timing: { pollMs: 10, stableMs: 50, settleMs: 400 } }).read('claude', workdir, open()), expected);
  assert.ok(Date.now() - started >= 400 && Date.now() - started < SLACK_MS);
  await assertTreeReaped(root);
  started = Date.now();
  assert.deepEqual(await new CliMcpServersReader({ claudeExecutable: executable, timeoutMs: 600, timing: { pollMs: 25, stableMs: 50, settleMs: 60_000 } }).read('claude', workdir, open()), expected);
  assert.ok(Date.now() - started >= 600 && Date.now() - started < SLACK_MS);
  await assertTreeReaped(root);
});

test('error, invalid and missing provider replies fail closed and terminate the process', async t => {
  const claudeReply = (subtype: string, body: string) => `printf '{"type":"control_response","response":{"subtype":"${subtype}","request_id":"%s",${body}}}\\n' "$id"`;
  const claudeFailures = [
    { initialize: claudeReply('error', '"error":"nope"') },
    { status: claudeReply('error', '"error":"Unsupported control request subtype: mcp_status"') },
    { status: claudeReply('success', '"response":{"commands":[]}') },
    { status: claudeReply('success', '"response":{"mcpServers":{"docs":{}}}') },
    { status: `printf '\\377\\n'` },
    { initialize: 'exit 3' },
    { initialize: 'exit 0' },
  ];
  for (const [index, fake] of claudeFailures.entries()) {
    const { root, workdir, executable } = await scenario(t, `claude-${index}`, root => claudeScript(root, fake));
    const started = Date.now();
    await assert.rejects(new CliMcpServersReader({ claudeExecutable: executable, timing: FAST, timeoutMs: 8_000 }).read('claude', workdir, open()), unavailable, String(index));
    assert.ok(Date.now() - started < 6_000, String(index));
    await assertTreeReaped(root);
  }
  const codexFailures = [
    { initialize: `printf '%s\\n' '{"id":0,"error":{"code":-32600,"message":"Invalid request"}}'` },
    { status: `printf '%s\\n' '{"id":1,"error":{"code":-32600,"message":"unknown variant"}}'` },
    { status: `printf '%s\\n' '{"id":1,"result":{}}'` },
    { status: `printf '%s\\n' '{"id":1,"result":{"data":"none"}}'` },
    { status: 'exit 3' },
    { initialize: 'exit 0' },
  ];
  for (const [index, fake] of codexFailures.entries()) {
    const { root, workdir, executable } = await scenario(t, `codex-${index}`, root => codexScript(root, fake));
    await writeJson(root, 'config.json', { config: {} });
    const started = Date.now();
    await assert.rejects(new CliMcpServersReader({ codexExecutable: executable, timeoutMs: 8_000 }).read('codex', workdir, open()), unavailable, String(index));
    assert.ok(Date.now() - started < 6_000, String(index));
    await assertTreeReaped(root);
  }
});

test('a failed, unusable, oversized or unanswered Codex config read keeps the status list unchanged', async t => {
  const padding = (bytes: number) => `head -c ${bytes} /dev/zero | tr '\\0' 'x'; echo`;
  const listed = `printf '{"id":1,"result":'; cat "$root/status.json"; printf '}\\n'`;
  const softFailures: readonly (readonly [string, ShellFake])[] = [
    ['error', { config: `printf '%s\\n' '{"id":2,"error":{"code":-32600,"message":"unknown variant"}}'` }],
    ['no-result', { config: `printf '%s\\n' '{"id":2}'` }],
    ['malformed', { config: `printf '%s\\n' '{"id":2,"result":{"config":{"mcp_servers":"none"}}}'` }],
    ['oversized', { config: padding(8 * MIB + 1) }],
    ['invalid-utf8', { config: `printf '\\377\\n'` }],
    ['exit-zero', { config: 'exit 0' }],
    ['exit-failure', { config: 'exit 3' }],
    ['exit-after-list', { status: `${listed}; exit 3` }],
    ['stdin-closed', { status: `${listed}; exec 0<&-; sleep 600` }],
  ];
  for (const [name, fake] of softFailures) {
    const { root, workdir, executable } = await scenario(t, `codex-config-${name}`, root => codexScript(root, fake));
    await writeJson(root, 'status.json', codexStatusWithSecrets);
    const started = Date.now();
    const snapshot = await new CliMcpServersReader({ codexExecutable: executable, timeoutMs: 9_000, timing: { configMs: 300 } }).read('codex', workdir, open());
    assert.deepEqual(validateMcpServers(snapshot), codexSnapshotWithoutConfig, name);
    assert.ok(Date.now() - started < SLACK_MS, name);
    await assertTreeReaped(root);
  }
  const silent = await scenario(t, 'codex-config-silent', root => codexScript(root, { config: ':' }));
  await writeJson(silent.root, 'status.json', codexStatusWithSecrets);
  const baseline = timers();
  const started = Date.now();
  assert.deepEqual(await new CliMcpServersReader({ codexExecutable: silent.executable, timeoutMs: 9_000, timing: { configMs: 400 } }).read('codex', silent.workdir, open()), codexSnapshotWithoutConfig);
  assert.ok(Date.now() - started >= 400 && Date.now() - started < SLACK_MS);
  await assertTreeReaped(silent.root);
  assert.equal(timers(), baseline);
  assert.equal((await lines(silent.root, 'stdin')).length, 4);

  const deadline = await scenario(t, 'codex-config-process-timeout', root => codexScript(root, { config: ':' }));
  await writeJson(deadline.root, 'status.json', codexStatusWithSecrets);
  assert.deepEqual(await new CliMcpServersReader({ codexExecutable: deadline.executable, timeoutMs: 500, timing: { configMs: 60_000 } }).read('codex', deadline.workdir, open()), codexSnapshotWithoutConfig);
  await assertTreeReaped(deadline.root);

  const aborted = await scenario(t, 'codex-config-abort', root => codexScript(root, { config: `echo waiting > "$root/config-requested"` }));
  await writeJson(aborted.root, 'status.json', codexStatusWithSecrets);
  const abort = new AbortController();
  const pending = assert.rejects(new CliMcpServersReader({ codexExecutable: aborted.executable, timing: { configMs: 60_000 } }).read('codex', aborted.workdir, abort.signal));
  const until = Date.now() + 8_000;
  while ((await lines(aborted.root, 'config-requested')).length === 0) {
    assert.ok(Date.now() < until, 'config/read was never requested');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  abort.abort();
  await pending;
  await assertTreeReaped(aborted.root);
});

test('an oversized line or stream fails closed while a line at the limit and a large Codex reply are accepted', async t => {
  const padding = (bytes: number) => `head -c ${bytes} /dev/zero | tr '\\0' 'x'; echo`;
  const claudeStatus = (first: string) => `if [ "$polls" -eq 1 ]; then ${first}; fi
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[{"name":"docs","status":"connected"}]}}}\\n' "$id"`;
  const claude = async (name: string, first: string) => {
    const made = await scenario(t, name, root => claudeScript(root, { status: claudeStatus(first) }));
    return { ...made, reader: new CliMcpServersReader({ claudeExecutable: made.executable, timing: FAST, timeoutMs: 10_000 }) };
  };
  const inside = await claude('claude-inside', padding(2 * MIB));
  assert.deepEqual((await inside.reader.read('claude', inside.workdir, open())).servers.map(server => server.name), ['docs']);
  await assertTreeReaped(inside.root);
  const flood = `i=0; while [ $i -lt 17 ]; do ${padding(MIB)}; i=$((i + 1)); done`;
  for (const [name, before] of [['claude-line', padding(2 * MIB + 1)], ['claude-stream', flood]] as const) {
    const oversized = await claude(name, before);
    const started = Date.now();
    await assert.rejects(oversized.reader.read('claude', oversized.workdir, open()), unavailable, name);
    assert.ok(Date.now() - started < 8_000, name);
    await assertTreeReaped(oversized.root);
  }

  const large = await scenario(t, 'codex-large', root => codexScript(root));
  await writeJson(large.root, 'config.json', { config: { mcp_servers: {} } });
  const tools = Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`tool-${index}`, { name: `tool-${index}`, description: 'd'.repeat(700), inputSchema: { type: 'object' } }]));
  await writeJson(large.root, 'status.json', { data: [{ name: 'codex_apps', httpOrigin: 'https://chatgpt.com', serverInfo: { name: 'apps' }, tools, authStatus: 'bearerToken' }], nextCursor: null });
  assert.ok((await readFile(join(large.root, 'status.json'))).length > 2 * MIB);
  const reader = new CliMcpServersReader({ codexExecutable: large.executable, timeoutMs: 10_000 });
  assert.deepEqual((await reader.read('codex', large.workdir, open())).servers, [
    { name: 'codex_apps', status: 'connected', scope: 'unknown', transport: 'http', endpointOrigin: 'https://chatgpt.com', toolCount: 4_000, detail: null }]);
  await assertTreeReaped(large.root);
  const huge = await scenario(t, 'codex-oversized', root => codexScript(root, { status: `${padding(8 * MIB + 1)}; printf '{"id":1,"result":{"data":[]}}\\n'` }));
  await writeJson(huge.root, 'config.json', { config: {} });
  const started = Date.now();
  await assert.rejects(new CliMcpServersReader({ codexExecutable: huge.executable, timeoutMs: 10_000 }).read('codex', huge.workdir, open()), unavailable);
  assert.ok(Date.now() - started < 8_000);
  await assertTreeReaped(huge.root);
});

test('timeout and abort kill the whole provider process tree', async t => {
  const { root, workdir, executable } = await scenario(t, 'hanging', root => hangingScript(root));
  const baseline = timers();
  for (const provider of ['claude', 'codex'] as const) {
    const started = Date.now();
    await assert.rejects(new CliMcpServersReader({ claudeExecutable: executable, codexExecutable: executable, timeoutMs: 700 }).read(provider, workdir, open()), unavailable, provider);
    assert.ok(Date.now() - started >= 650 && Date.now() - started < 6_000, provider);
    await assertTreeReaped(root);
    await rm(join(root, 'pid')); await rm(join(root, 'descendant-pid'));
  }
  for (const provider of ['claude', 'codex'] as const) {
    const abort = new AbortController();
    const pending = assert.rejects(new CliMcpServersReader({ claudeExecutable: executable, codexExecutable: executable }).read(provider, workdir, abort.signal));
    const active = await readPid(root), descendant = await readPid(root, 'descendant-pid');
    abort.abort();
    await pending;
    await assertTreeReaped(root);
    assert.deepEqual([active > 0, descendant > 0], [true, true]);
    await rm(join(root, 'pid')); await rm(join(root, 'descendant-pid'));
  }
  assert.equal(timers(), baseline);
});

test('an abort during Claude polling kills the process and stops further requests', async t => {
  const { root, workdir, executable } = await scenario(t, 'claude', root => claudeScript(root));
  await writeJson(root, 'servers.json', { mcpServers: [{ name: 'slow', status: 'pending' }] });
  const abort = new AbortController();
  const pending = assert.rejects(new CliMcpServersReader({ claudeExecutable: executable, timing: { pollMs: 50, stableMs: 50, settleMs: 60_000 } }).read('claude', workdir, abort.signal));
  const until = Date.now() + 8_000;
  while ((await lines(root, 'stdin')).length < 4) {
    assert.ok(Date.now() < until, 'Claude polling never started');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  abort.abort();
  await pending;
  await assertTreeReaped(root);
  const written = (await lines(root, 'stdin')).length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await lines(root, 'stdin')).length, written);
});

test('a replaced project directory, an aborted read or an unsafe configuration never launches a provider', async t => {
  const { root, workdir } = await workspace(t);
  const claudeExecutable = await shellFixture(root, 'claude', claudeScript(root));
  const codexExecutable = await shellFixture(root, 'codex', codexScript(root));
  const reader = new CliMcpServersReader({ claudeExecutable, codexExecutable });
  const foreign: McpServersWorkdir = { cwd: workdir.cwd, identity: { dev: workdir.identity.dev, ino: workdir.identity.ino + 1 } };
  await assert.rejects(reader.read('claude', foreign, open()), unavailable);
  await assert.rejects(reader.read('codex', foreign, open()), unavailable);
  await assert.rejects(reader.read('codex', { ...workdir, cwd: 'relative' }, open()), unavailable);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(reader.read('claude', workdir, aborted.signal));
  await assert.rejects(reader.read('codex', workdir, aborted.signal));
  assert.deepEqual(await lines(root, 'launches'), []);
  await assert.rejects(new CliMcpServersReader({ claudeExecutable: join(root, 'absent') }).read('claude', workdir, open()), unavailable);
  for (const options of [{ claudeExecutable: 'bin/claude' }, { codexExecutable: './codex' }, { claudeExecutable: '' }, { codexExecutable: '/bin/codex\0' }])
    assert.throws(() => new CliMcpServersReader(options), { message: 'invalid_provider_executable' });
  for (const options of [{ timing: { pollMs: 0 } }, { timing: { stableMs: -1 } }, { timing: { settleMs: Number.NaN } }, { timing: { configMs: 0 } }, { timeoutMs: 0 }])
    assert.throws(() => new CliMcpServersReader(options), { message: 'invalid_mcp_servers_timing' });
});
