import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { lines, shellFixture } from './mcp-servers-fixture.js';

const exec = promisify(execFile);
const SECRET = 'DEVICE_SYNC_SECRET';
type Reply = Readonly<{ status: number; body: unknown; text: string }>;
const descriptor = (runnerId: string) => ({ protocolVersion: 1 as const, runnerId, name: 'Device sync', capabilities: { taskExecution: false, eventReplay: true } });
const stdio = (command: string, token = SECRET) => ({ kind: 'stdio', command, args: ['-y', 'server'], env: { TOKEN: token } });
const http = (token = SECRET) => ({ kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${token}` } });
const sync = (servers: readonly unknown[], retain: readonly string[] = []) => ({ version: 1, servers, retain });

const fakeClaude = (config: string, log: string) => `
const fs = require('node:fs');
const [, , group, command, , , , name, json] = process.argv;
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2, 7).join(' ') + ' ' + name + '\\n');
if (group !== 'mcp') process.exit(2);
const read = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8')); } catch { return {}; } };
const config = read();
config.projects ??= {};
const project = (config.projects[process.cwd()] ??= {});
project.mcpServers ??= {};
const servers = project.mcpServers;
if (command === 'add-json') {
  if (Object.hasOwn(servers, name)) { console.error('MCP server ' + name + ' already exists in local config'); process.exit(1); }
  if (fs.existsSync(${JSON.stringify(config)} + '.refuse')) { console.error('refused ' + json); process.exit(1); }
  servers[name] = JSON.parse(json);
  fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
  console.log('Added MCP server ' + name + ' to local config');
  process.exit(0);
}
if (command === 'remove') {
  if (!Object.hasOwn(servers, name)) { console.error('No MCP server named "' + name + '" in local scope'); process.exit(1); }
  delete servers[name];
  fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
  console.log('Removed MCP server ' + name + ' from local config');
  process.exit(0);
}
process.exit(2);
`;

async function runner(t: TestContext, configure: (root: string) => Promise<Partial<RunnerExecutionOptions>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-device-sync-api-')));
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
    return { status: response.status, body: JSON.parse(text), text };
  };
  const capabilities = async (extra: Readonly<Record<string, string>>) =>
    (await (await fetch(`${base}/v1/runner`, { headers: { ...headers, ...extra } })).json()).capabilities as Record<string, unknown>;
  return { root, base, headers, call, capabilities, project: join(root, 'project'), config: join(root, 'claude-home', '.claude.json'),
    log: join(root, 'claude-fake', 'log'), data: join(root, 'data') };
}

async function syncRunner(t: TestContext) {
  return runner(t, async root => {
    const project = join(root, 'project'), fake = join(root, 'claude-fake'), home = join(root, 'claude-home');
    for (const directory of [project, fake, home]) await mkdir(directory);
    await exec('git', ['init', '-q', project]);
    const config = join(home, '.claude.json'), log = join(fake, 'log');
    await writeFile(join(fake, 'claude.cjs'), fakeClaude(config, log));
    const claudeExecutable = await shellFixture(fake, 'claude', `#!/bin/sh\nexec '${process.execPath}' '${join(fake, 'claude.cjs')}' "$@"\n`);
    return { projects: [{ id: 'example', name: 'Example', path: project }], claudeLocalConfigPath: config,
      mcpServerManagementCli: { claudeExecutable } };
  });
}
async function storedConfig(path: string): Promise<{ projects: Record<string, { mcpServers: Record<string, unknown> }> }> {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('mcpDeviceSync is advertised only when announced in either capability header', async t => {
  const state = await syncRunner(t);
  const legacy = await state.capabilities({});
  assert.equal('mcpDeviceSync' in legacy, false);
  assert.equal((await state.capabilities({ 'x-codevo-client-capabilities': 'mcpDeviceSync' })).mcpDeviceSync, true);
  assert.equal((await state.capabilities({ 'x-codevo-client-capabilities-2': 'mcpDeviceSync' })).mcpDeviceSync, true);
  const both = await state.capabilities({ 'x-codevo-client-capabilities': 'mcpServers,mcpServerManagement', 'x-codevo-client-capabilities-2': 'mcpDeviceSync' });
  assert.deepEqual([both.mcpServers, both.mcpServerManagement, both.mcpDeviceSync], [false, true, true]);
  const crowded = Array.from({ length: 16 }, (_, index) => `token${index}`).join(',') + ',mcpDeviceSync';
  const overLimit = await state.capabilities({ 'x-codevo-client-capabilities': 'mcpServerManagement', 'x-codevo-client-capabilities-2': crowded });
  assert.deepEqual([overLimit.mcpServerManagement, 'mcpDeviceSync' in overLimit], [true, false]);
  const nonAscii = await state.capabilities({ 'x-codevo-client-capabilities': 'mcpServerManagement', 'x-codevo-client-capabilities-2': 'mcpDeviceSync,café' });
  assert.deepEqual([nonAscii.mcpServerManagement, 'mcpDeviceSync' in nonAscii], [true, false]);
  const firstCrowded = Array.from({ length: 17 }, (_, index) => `token${index}`).join(',');
  const firstOver = await state.capabilities({ 'x-codevo-client-capabilities': `${firstCrowded},mcpServerManagement`, 'x-codevo-client-capabilities-2': 'mcpDeviceSync' });
  assert.deepEqual(['mcpServerManagement' in firstOver, firstOver.mcpDeviceSync], [false, true]);
  const sixteen = Array.from({ length: 15 }, (_, index) => `token${index}`).join(',') + ',mcpDeviceSync';
  assert.equal((await state.capabilities({ 'x-codevo-client-capabilities-2': sixteen })).mcpDeviceSync, true);
  assert.equal('mcpDeviceSync' in (await state.capabilities({ 'x-codevo-client-capabilities-2': 'mcpdevicesync' })), false);

  const disabled = await runner(t, async () => ({}));
  assert.equal((await disabled.capabilities({ 'x-codevo-client-capabilities-2': 'mcpDeviceSync' })).mcpDeviceSync, false);
  const refused = await disabled.call('PUT', '/v1/projects/example/mcp-servers/claude/device-sync', sync([]));
  assert.deepEqual([refused.status, refused.body], [404, { error: 'not_found' }]);
});

test('the device sync route enforces media, size, shape and provider before any CLI starts', async t => {
  const state = await syncRunner(t);
  const route = '/v1/projects/example/mcp-servers/claude/device-sync';
  const text = await fetch(state.base + route, { method: 'PUT', headers: { ...state.headers, 'content-type': 'text/plain' }, body: JSON.stringify(sync([])) });
  assert.equal(text.status, 415);
  const encoded = await state.call('PUT', route, sync([]), { 'content-encoding': 'gzip' });
  assert.equal(encoded.status, 415);
  const large = await state.call('PUT', route, JSON.stringify({ ...sync([]), pad: 'x'.repeat(256 * 1024) }));
  assert.deepEqual([large.status, large.body], [413, { error: 'too_large' }]);
  const unknown = await state.call('PUT', route, { ...sync([]), extra: SECRET });
  assert.deepEqual([unknown.status, unknown.body], [400, { error: 'invalid_input' }]);
  const header = await state.call('PUT', route, sync([{ name: 'web', launch: http(`${SECRET}\r\nX-Evil: 1`) }]));
  assert.deepEqual([header.status, header.body], [400, { error: 'invalid_input' }]);
  assert.ok(!header.text.includes(SECRET));
  const codex = await state.call('PUT', '/v1/projects/example/mcp-servers/codex/device-sync', sync([{ name: 'docs', launch: stdio('sh') }]));
  assert.deepEqual([codex.status, codex.body], [409, { error: 'mcp_change_unsupported' }]);
  const provider = await state.call('PUT', '/v1/projects/example/mcp-servers/other/device-sync', sync([]));
  assert.deepEqual([provider.status, provider.body], [404, { error: 'not_found' }]);
  const project = await state.call('PUT', '/v1/projects/missing/mcp-servers/claude/device-sync', sync([]));
  assert.deepEqual([project.status, project.body], [404, { error: 'not_found' }]);
  const post = await state.call('POST', route, sync([]));
  assert.equal(post.status, 405);
  const anonymous = await fetch(state.base + route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sync([])) });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await lines(join(state.root, 'claude-fake'), 'log'), []);
});

test('a device sync installs, updates, keeps and removes local-scope entries through the Claude CLI', async t => {
  const state = await syncRunner(t);
  const route = '/v1/projects/example/mcp-servers/claude/device-sync';
  const key = await realpath(state.project);
  await writeFile(state.config, JSON.stringify({ mcpServers: { userOwned: { command: 'u' } }, projects: { [key]: { mcpServers: { own: { command: 'own' } } } } }));

  const first = await state.call('PUT', route, sync([
    { name: 'docs', launch: stdio('sh') }, { name: 'web', launch: http() }, { name: 'own', launch: stdio('sh') },
    { name: 'mac', launch: stdio('/Users/someone/bin/server') },
  ], ['skipped']));
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body, { version: 1, results: [
    { name: 'docs', outcome: 'added' }, { name: 'web', outcome: 'added' }, { name: 'own', outcome: 'keptServerEntry' }, { name: 'mac', outcome: 'commandMissing' },
  ] });
  assert.ok(!first.text.includes(SECRET));
  const afterFirst = (await storedConfig(state.config)).projects[key]!.mcpServers;
  assert.deepEqual(afterFirst.docs, { type: 'stdio', command: 'sh', args: ['-y', 'server'], env: { TOKEN: SECRET } });
  assert.deepEqual(afterFirst.web, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(afterFirst.own, { command: 'own' });
  assert.equal('mac' in afterFirst, false);
  const ledgerPath = join(state.data, 'mcp-device-sync', 'example.json');
  const ledgerText = await readFile(ledgerPath, 'utf8');
  assert.ok(!ledgerText.includes(SECRET));
  assert.deepEqual((JSON.parse(ledgerText) as { servers: { name: string }[] }).servers.map(entry => entry.name), ['docs', 'web']);
  assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  assert.deepEqual(await lines(join(state.root, 'claude-fake'), 'log'), ['mcp add-json --scope local -- docs', 'mcp add-json --scope local -- web']);

  const config = await storedConfig(state.config);
  config.projects[key]!.mcpServers.web = { type: 'http', url: 'https://edited.example.com/mcp' };
  await writeFile(state.config, JSON.stringify(config));
  const second = await state.call('PUT', route, sync([{ name: 'docs', launch: stdio('sh', 'ROTATED') }]));
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.body, { version: 1, results: [{ name: 'docs', outcome: 'updated' }, { name: 'web', outcome: 'keptServerEntry' }] });
  const afterSecond = (await storedConfig(state.config)).projects[key]!.mcpServers;
  assert.deepEqual(afterSecond.docs, { type: 'stdio', command: 'sh', args: ['-y', 'server'], env: { TOKEN: 'ROTATED' } });
  assert.deepEqual(afterSecond.web, { type: 'http', url: 'https://edited.example.com/mcp' });

  const third = await state.call('PUT', route, sync([]));
  assert.deepEqual(third.body, { version: 1, results: [{ name: 'docs', outcome: 'removed' }] });
  const afterThird = (await storedConfig(state.config)).projects[key]!.mcpServers;
  assert.deepEqual(Object.keys(afterThird).sort(), ['own', 'web']);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, 'utf8')), { version: 1, servers: [] });
  assert.deepEqual((await storedConfig(state.config) as unknown as { mcpServers: unknown }).mcpServers, { userOwned: { command: 'u' } });
});

test('a CLI refusal is reported failed without echoing the configuration', async t => {
  const state = await syncRunner(t);
  await writeFile(`${state.config}.refuse`, '');
  const reply = await state.call('PUT', '/v1/projects/example/mcp-servers/claude/device-sync', sync([{ name: 'web', launch: http() }]));
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.body, { version: 1, results: [{ name: 'web', outcome: 'failed' }] });
  assert.ok(!reply.text.includes(SECRET));
  await assert.rejects(readFile(join(state.data, 'mcp-device-sync', 'example.json')));
});
