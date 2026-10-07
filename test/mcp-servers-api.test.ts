import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { validateMcpServers } from '../src/domain/mcp-servers.js';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import {
  MARKER, assertTreeReaped, claudeScript, claudeServersWithSecrets, claudeSnapshotWithoutSecrets, codexConfigWithSecrets, codexScript, codexSnapshotWithoutSecrets,
  codexStatusWithSecrets, lines, readPid, shellFixture, writeJson, type ShellFake,
} from './mcp-servers-fixture.js';

const exec = promisify(execFile);
type RemoteRequest = Readonly<{ name: string; value: Readonly<{ projectId?: string; provider?: string }> }>;
const contract = JSON.parse(readFileSync(new URL('../../test/fixtures/agent-mcp-servers-wire.json', import.meta.url), 'utf8')) as
  Readonly<{ remoteRunnerCapability: string; remoteRequests: readonly RemoteRequest[]; rejectedRemoteRequests: readonly RemoteRequest[] }>;
const remotePath = (request: RemoteRequest) => `/v1/projects/${request.value.projectId}/mcp-servers/${request.value.provider}`;
const descriptor = (runnerId: string) => ({ protocolVersion: 1 as const, runnerId, name: 'Servers', capabilities: { taskExecution: false, eventReplay: true } });
const SLOW_STATUS = `sleep 1; printf '{"id":1,"result":'; cat "$root/status.json"; printf '}\\n'`;

async function runner(t: TestContext, configure: (root: string) => Promise<Partial<RunnerExecutionOptions>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-servers-api-')));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [], ...await configure(root) });
  const app = await createRunnerApplication(descriptor(runnerId), header => header === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  return { root, claude: join(root, 'claude-fake'), codex: join(root, 'codex-fake'), runnerId, services, app,
    base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`, headers: { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId } };
}
async function serversRunner(t: TestContext, codexFake: ShellFake = {}, timeoutMs?: number) {
  return runner(t, async root => {
    const project = join(root, 'project'), plain = join(root, 'plain'), claude = join(root, 'claude-fake'), codex = join(root, 'codex-fake');
    for (const directory of [project, plain, claude, codex]) await mkdir(directory);
    await exec('git', ['init', '-q', project]);
    await writeJson(claude, 'servers-1.json', { mcpServers: [] });
    await writeJson(claude, 'servers.json', { mcpServers: claudeServersWithSecrets });
    await writeJson(codex, 'config.json', codexConfigWithSecrets);
    await writeJson(codex, 'status.json', codexStatusWithSecrets);
    return { projects: [{ id: 'example', name: 'Example', path: project }, { id: 'plain', name: 'Plain', path: plain }, { id: 'absent', name: 'Absent', path: join(root, 'absent') },
      { id: contract.remoteRequests[0]!.value.projectId!, name: 'Contract', path: project }],
      mcpServersCli: { claudeExecutable: await shellFixture(claude, 'claude', claudeScript(claude)), codexExecutable: await shellFixture(codex, 'codex', codexScript(codex, codexFake)),
        timing: { pollMs: 10, stableMs: 100, settleMs: 5_000 }, ...(timeoutMs === undefined ? {} : { timeoutMs }) } };
  });
}
function getWithBody(url: string, headers: Readonly<Record<string, string>>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: 'GET', headers: { ...headers, 'content-length': '2' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end('{}');
  });
}
async function launched(root: string, count: number): Promise<void> {
  const until = Date.now() + 8_000;
  while ((await lines(root, 'launches')).length < count) {
    assert.ok(Date.now() < until, `launch ${count} never started`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('mcpServers is announced only to clients that understand it and only with a probe configuration', async t => {
  const { base, headers } = await serversRunner(t);
  assert.equal(contract.remoteRunnerCapability, 'mcpServers');
  const legacy = (await (await fetch(`${base}/v1/runner`, { headers })).json()).capabilities;
  assert.equal('mcpServers' in legacy, false);
  assert.deepEqual((await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'accountUsage' } })).json()).capabilities, { ...legacy, accountUsage: true });
  const modern = (await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'accountUsage,mcpServers,commandCatalog' } })).json()).capabilities;
  assert.deepEqual(modern, { ...legacy, accountUsage: true, mcpServers: true, commandCatalog: false });

  const injected = await runner(t, async () => ({}));
  const silent = (await (await fetch(`${injected.base}/v1/runner`, { headers: { ...injected.headers, 'x-codevo-client-capabilities': 'mcpServers' } })).json()).capabilities;
  assert.equal(silent.mcpServers, false);
  const disabled = await fetch(`${injected.base}/v1/projects/example/mcp-servers/claude`, { headers: injected.headers });
  assert.deepEqual([disabled.status, await disabled.json()], [404, { error: 'not_found' }]);

  const discovery = await createRunnerApplication({ ...descriptor(randomUUID()), capabilities: { taskExecution: false, eventReplay: true, mcpServers: true } }, () => true);
  t.after(() => discovery.close());
  await discovery.listen(0, '127.0.0.1');
  const address = `http://127.0.0.1:${(discovery.getHttpServer().address() as AddressInfo).port}`;
  const only = await (await fetch(`${address}/v1/runner`, { headers: { 'x-codevo-client-capabilities': 'mcpServers' } })).json();
  assert.equal(only.capabilities.mcpServers, false);
  assert.equal((await fetch(`${address}/v1/projects/example/mcp-servers/claude`)).status, 404);
});

test('MCP server routes enforce auth, owner identity, method, body and exact paths before any probe', async t => {
  const { base, headers, claude, codex } = await serversRunner(t);
  for (const provider of ['claude', 'codex']) {
    const url = `${base}/v1/projects/example/mcp-servers/${provider}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong', 'x-codevo-runner-id': headers['x-codevo-runner-id'] } })).status, 401);
    const anonymous = await fetch(url, { headers: { authorization: 'Bearer test' } });
    assert.deepEqual([anonymous.status, await anonymous.json()], [409, { error: 'runner_identity_mismatch' }]);
    assert.equal((await fetch(url, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(url + '?cwd=/tmp', { headers })).status, 404);
    assert.equal((await fetch(url + '/', { headers })).status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refused = await fetch(url, { method, headers });
      assert.deepEqual([refused.status, await refused.json()], [405, { error: 'method_not_allowed' }], method);
    }
    assert.equal(await getWithBody(url, headers), 400);
  }
  for (const path of ['/v1/projects/example/mcp-servers/other', '/v1/projects/example/mcp-servers/claudeCode', '/v1/projects/example/mcp-servers',
    '/v1/projects/-bad/mcp-servers/claude', '/v1/projects/../mcp-servers/claude', `/v1/projects/${'a'.repeat(65)}/mcp-servers/codex`,
    '/v1/projects/missing/mcp-servers/claude', '/v1/projects/missing/mcp-servers/codex']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' }, path);
  }
  const routed = ['localProviderName', 'emptyProjectId', 'projectIdWithSlash', 'projectIdTooLong'];
  const rejected = contract.rejectedRemoteRequests.filter(example => routed.includes(example.name));
  assert.equal(rejected.length, routed.length);
  for (const example of rejected) assert.equal((await fetch(base + remotePath(example), { headers })).status, 404, example.name);
  assert.deepEqual([await lines(claude, 'launches'), await lines(codex, 'launches')], [[], []]);
});

test('MCP server API returns the closed contract from the project checkout with one fresh probe per request', async t => {
  const { base, headers, root, claude, codex, services } = await serversRunner(t);
  const read = async (path: string) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    for (const secret of [MARKER, '4242', root, 'server --token', 'Bearer']) assert.equal(text.includes(secret), false, secret);
    return validateMcpServers(JSON.parse(text));
  };
  assert.deepEqual(await read('/v1/projects/example/mcp-servers/claude'), claudeSnapshotWithoutSecrets);
  assert.deepEqual(await read('/v1/projects/example/mcp-servers/codex'), codexSnapshotWithoutSecrets);
  await assertTreeReaped(claude);
  await assertTreeReaped(codex);
  assert.deepEqual([await lines(claude, 'cwd'), await lines(codex, 'cwd')], [[join(root, 'project')], [join(root, 'project')]]);
  assert.equal((await lines(claude, 'args')).includes('--strict-mcp-config'), false);
  assert.equal((await lines(claude, 'env')).some(entry => entry.startsWith('ENABLE_CLAUDEAI_MCP_SERVERS=')), false);

  await writeJson(codex, 'status.json', { data: [], nextCursor: null });
  assert.deepEqual(await read('/v1/projects/example/mcp-servers/codex'), { version: 1, provider: 'codex', truncated: false, servers: [] });
  assert.deepEqual(await read('/v1/projects/example/mcp-servers/claude'), claudeSnapshotWithoutSecrets);
  assert.deepEqual([(await lines(claude, 'launches')).length, (await lines(codex, 'launches')).length], [2, 2]);
  assert.deepEqual(contract.remoteRequests.map(example => example.value.provider).sort(), ['claude', 'codex']);
  for (const example of contract.remoteRequests) assert.equal((await read(remotePath(example))).provider, example.value.provider, example.name);
  assert.deepEqual([(await lines(claude, 'launches')).length, (await lines(codex, 'launches')).length], [3, 3]);

  for (const path of ['/v1/projects/plain/mcp-servers/claude', '/v1/projects/plain/mcp-servers/codex', '/v1/projects/absent/mcp-servers/claude']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), '{"error":"storage_unavailable"}', path);
  }
  assert.deepEqual([(await lines(claude, 'launches')).length, (await lines(codex, 'launches')).length], [3, 3]);

  await services.close();
  await assert.rejects(services.mcpServers!.read('example', 'claude', new AbortController().signal), { name: 'RunnerError', code: 'storage_unavailable' });
});

test('a third concurrent MCP server probe is refused as busy and the slots are released afterwards', async t => {
  const { base, headers, codex } = await serversRunner(t, { status: SLOW_STATUS });
  const url = `${base}/v1/projects/example/mcp-servers/codex`;
  const slow = [fetch(url, { headers }), fetch(url, { headers })];
  await launched(codex, 2);
  const refused = await fetch(`${base}/v1/projects/example/mcp-servers/claude`, { headers });
  assert.deepEqual([refused.status, await refused.text()], [503, '{"error":"busy"}']);
  for (const response of await Promise.all(slow)) assert.deepEqual([response.status, validateMcpServers(await response.json())], [200, codexSnapshotWithoutSecrets]);
  const admitted = await fetch(`${base}/v1/projects/example/mcp-servers/claude`, { headers });
  assert.deepEqual([admitted.status, await admitted.json()], [200, claudeSnapshotWithoutSecrets]);
  assert.equal((await lines(codex, 'launches')).length, 2);
});

test('a probe timeout is reported as unavailable and terminates the provider', async t => {
  const { base, headers, codex } = await serversRunner(t, { status: ':' }, 600);
  const started = Date.now();
  const response = await fetch(`${base}/v1/projects/example/mcp-servers/codex`, { headers });
  assert.deepEqual([response.status, await response.text()], [503, '{"error":"storage_unavailable"}']);
  assert.ok(Date.now() - started >= 550 && Date.now() - started < 6_000);
  await assertTreeReaped(codex);
});

test('a client disconnect and a runner shutdown terminate the provider process tree', async t => {
  const { base, headers, codex, services } = await serversRunner(t, { status: ':' });
  const url = `${base}/v1/projects/example/mcp-servers/codex`;
  const client = new AbortController();
  const dropped = assert.rejects(fetch(url, { headers, signal: client.signal }), { name: 'AbortError' });
  await launched(codex, 1);
  const first = await readPid(codex);
  client.abort();
  await dropped;
  await assertTreeReaped(codex);
  await rm(join(codex, 'pid'));
  await rm(join(codex, 'descendant-pid'));

  const pending = fetch(url, { headers });
  await launched(codex, 2);
  const second = await readPid(codex);
  assert.notEqual(second, first);
  await readPid(codex, 'descendant-pid');
  await services.close();
  const response = await pending;
  assert.deepEqual([response.status, await response.text()], [503, '{"error":"storage_unavailable"}']);
  await assertTreeReaped(codex);
  assert.equal((await lines(codex, 'stdin')).some(entry => entry.includes('"user"')), false);
});
