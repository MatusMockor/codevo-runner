import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { validateCommandCatalog } from '../src/domain/command-catalog.js';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const exec = promisify(execFile);
type RemoteRequest = Readonly<{ name: string; value: Readonly<{ projectId?: string; provider?: string }> }>;
const contract = JSON.parse(readFileSync(new URL('../../test/fixtures/agent-command-catalog-wire.json', import.meta.url), 'utf8')) as
  Readonly<{ remoteRunnerCapability: string; remoteRequests: readonly RemoteRequest[]; rejectedRemoteRequests: readonly RemoteRequest[] }>;
const remotePath = (request: RemoteRequest) => `/v1/projects/${request.value.projectId}/command-catalog/${request.value.provider}`;
const descriptor = (runnerId: string) => ({ protocolVersion: 1 as const, runnerId, name: 'Catalog', capabilities: { taskExecution: false, eventReplay: true } });

async function fixture(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name + '.cjs');
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o700);
  return path;
}
async function runner(t: TestContext, configure: (root: string) => Promise<Partial<RunnerExecutionOptions>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-command-catalog-api-')));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [], ...await configure(root) });
  const app = await createRunnerApplication(descriptor(runnerId), header => header === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  return { root, runnerId, services, app, base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`,
    headers: { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId } };
}
async function catalogRunner(t: TestContext) {
  return runner(t, async root => {
    const project = join(root, 'project'), plain = join(root, 'plain');
    await mkdir(project); await mkdir(plain);
    await exec('git', ['init', '-q', project]);
    const launches = JSON.stringify(join(root, 'launches'));
    const claudeExecutable = await fixture(root, 'claude', `
const fs = require('node:fs'); let input = '';
process.stdin.setEncoding('utf8').on('data', chunk => { input += chunk; }).on('end', () => {
  fs.appendFileSync(${launches}, JSON.stringify({ provider: 'claude', cwd: process.cwd() }) + '\\n');
  setTimeout(() => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(input).request_id,
    response: { commands: [{ name: 'pr', description: 'Open a\\npull request.', argumentHint: '[title]', builtin: true }, { name: '__internal' }, { name: 'plain' }],
      account: { email: 'person@example.invalid' } } } })), 80);
});`);
    const codexExecutable = await fixture(root, 'codex', `
const fs = require('node:fs'); const readline = require('node:readline');
fs.appendFileSync(${launches}, JSON.stringify({ provider: 'codex', cwd: process.cwd() }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 0) return console.log(JSON.stringify({ id: 0, result: {} }));
  if (request.id === undefined) return;
  setTimeout(() => console.log(JSON.stringify({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], errors: [], skills: [
    { name: 'work-pets:create-pet', description: 'Long.', interface: { displayName: 'Create Pet', shortDescription: 'Create a pet.' }, path: '/home/synthetic/SKILL.md', scope: 'user', enabled: true },
    { name: 'skill-creator', description: 'Create or update a skill.', path: '/home/synthetic/system/SKILL.md', scope: 'system', enabled: true }] }] } })), 80);
});
setInterval(() => {}, 1000);`);
    return { projects: [{ id: 'example', name: 'Example', path: project }, { id: 'plain', name: 'Plain', path: plain }, { id: 'absent', name: 'Absent', path: join(root, 'absent') },
      { id: contract.remoteRequests[0]!.value.projectId!, name: 'Contract', path: project }],
      commandCatalogCli: { claudeExecutable, codexExecutable, codexSettle: { pollMs: 10, settleMs: 200, capMs: 5_000 } } };
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

test('commandCatalog is announced only to clients that understand it and only with a probe configuration', async t => {
  const { base, headers } = await catalogRunner(t);
  assert.equal(contract.remoteRunnerCapability, 'commandCatalog');
  const legacy = (await (await fetch(`${base}/v1/runner`, { headers })).json()).capabilities;
  assert.equal('commandCatalog' in legacy, false);
  assert.deepEqual((await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'accountUsage' } })).json()).capabilities, { ...legacy, accountUsage: true });
  const modern = (await (await fetch(`${base}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'accountUsage,commandCatalog' } })).json()).capabilities;
  assert.deepEqual(modern, { ...legacy, accountUsage: true, commandCatalog: true });

  const injected = await runner(t, async () => ({}));
  const silent = (await (await fetch(`${injected.base}/v1/runner`, { headers: { ...injected.headers, 'x-codevo-client-capabilities': 'commandCatalog' } })).json()).capabilities;
  assert.equal(silent.commandCatalog, false);
  assert.deepEqual(await (await fetch(`${injected.base}/v1/projects/example/command-catalog/claude`, { headers: injected.headers })).json(), { error: 'not_found' });

  const discovery = await createRunnerApplication({ ...descriptor(randomUUID()), capabilities: { taskExecution: false, eventReplay: true, commandCatalog: true } }, () => true);
  t.after(() => discovery.close());
  await discovery.listen(0, '127.0.0.1');
  const only = await (await fetch(`http://127.0.0.1:${(discovery.getHttpServer().address() as AddressInfo).port}/v1/runner`, { headers: { 'x-codevo-client-capabilities': 'commandCatalog' } })).json();
  assert.equal(only.capabilities.commandCatalog, false);
});

test('command catalog routes enforce auth, owner identity, method, body and exact paths before any probe', async t => {
  const { base, headers, root } = await catalogRunner(t);
  for (const provider of ['claude', 'codex']) {
    const url = `${base}/v1/projects/example/command-catalog/${provider}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong', 'x-codevo-runner-id': headers['x-codevo-runner-id'] } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer test' } })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(url + '?cwd=/tmp', { headers })).status, 404);
    assert.equal((await fetch(url + '/', { headers })).status, 404);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url, { method, headers })).status, 405, method);
    assert.equal(await getWithBody(url, headers), 400);
  }
  for (const path of ['/v1/projects/example/command-catalog/other', '/v1/projects/example/command-catalog/claudeCode', '/v1/projects/example/command-catalog',
    '/v1/projects/-bad/command-catalog/claude', '/v1/projects/../command-catalog/claude', `/v1/projects/${'a'.repeat(65)}/command-catalog/codex`,
    '/v1/projects/missing/command-catalog/claude', '/v1/projects/missing/command-catalog/codex']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' }, path);
  }
  const routed = ['localProviderName', 'emptyProjectId', 'projectIdWithSlash', 'projectIdTooLong'];
  const rejected = contract.rejectedRemoteRequests.filter(example => routed.includes(example.name));
  assert.equal(rejected.length, routed.length);
  for (const example of rejected) assert.equal((await fetch(base + remotePath(example), { headers })).status, 404, example.name);
  await assert.rejects(readFile(join(root, 'launches')), { code: 'ENOENT' });
});

test('command catalog API returns the closed contract from the project checkout and coalesces reads', async t => {
  const { base, headers, root, services } = await catalogRunner(t);
  const read = async (path: string) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return validateCommandCatalog(await response.json());
  };
  const replies = await Promise.all(Array.from({ length: 8 }, () => read('/v1/projects/example/command-catalog/claude')));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  assert.deepEqual(replies[0], { version: 1, provider: 'claudeCode', truncated: false, entries: [
    { kind: 'command', name: 'pr', label: null, description: 'Open a pull request.', argumentHint: '[title]', builtin: true },
    { kind: 'command', name: 'plain', label: null, description: null, argumentHint: null, builtin: false },
  ] });
  const skills = await Promise.all(Array.from({ length: 4 }, () => read('/v1/projects/example/command-catalog/codex')));
  assert.deepEqual(skills[3], { version: 1, provider: 'codex', truncated: false, entries: [
    { kind: 'skill', name: 'work-pets:create-pet', label: 'Create Pet', description: 'Create a pet.', argumentHint: null, builtin: false },
    { kind: 'skill', name: 'skill-creator', label: null, description: 'Create or update a skill.', argumentHint: null, builtin: true },
  ] });
  assert.deepEqual(await read('/v1/projects/example/command-catalog/claude'), replies[0]);
  const launches = (await readFile(join(root, 'launches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(launches, [{ provider: 'claude', cwd: join(root, 'project') }, { provider: 'codex', cwd: join(root, 'project') }]);
  assert.deepEqual(contract.remoteRequests.map(example => example.value.provider).sort(), ['claude', 'codex']);
  for (const example of contract.remoteRequests)
    assert.deepEqual(await read(remotePath(example)), example.value.provider === 'claude' ? replies[0] : skills[0], example.name);
  const text = JSON.stringify([replies[0], skills[0]]);
  for (const secret of ['example.invalid', 'synthetic', 'SKILL.md', root]) assert.equal(text.includes(secret), false, secret);

  for (const path of ['/v1/projects/plain/command-catalog/claude', '/v1/projects/plain/command-catalog/codex', '/v1/projects/absent/command-catalog/claude']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), '{"error":"storage_unavailable"}', path);
  }
  assert.equal((await readFile(join(root, 'launches'), 'utf8')).trim().split('\n').length, 4);

  await services.close();
  await assert.rejects(services.commandCatalog!.read('example', 'claudeCode'), { name: 'RunnerError', code: 'storage_unavailable' });
});
