import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { comparePorts, isPortList, processName, type ListeningPort } from '../src/domain/port-preview.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

type Example = Readonly<{ name: string; value: unknown }>;
type Section = Readonly<{ accepted: readonly Example[]; rejected: readonly Example[] }>;
type Fixture = Readonly<{ schemaVersion: number; capability: string; sections: Readonly<Record<string, Section>> }>;
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/remote-port-preview-wire.json', import.meta.url), 'utf8')) as Fixture;
const editorOnly = new Set(['portScope', 'portListRequest', 'portOpenRequest', 'portCloseRequest', 'portReleaseOwnerRequest', 'portListing', 'portOpenResponse']);

test('port list validator accepts and rejects exactly the shared fixture payloads', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.capability, 'portPreview');
  for (const name of Object.keys(fixture.sections)) assert.ok(editorOnly.has(name) || name === 'portList', `unconsumed section ${name}`);
  const { accepted, rejected } = fixture.sections.portList!;
  for (const example of accepted) assert.equal(isPortList(example.value), true, example.name);
  for (const example of rejected) assert.equal(isPortList(example.value), false, example.name);
});

test('port ordering is strict by port, address family and source', () => {
  const ports: ListeningPort[] = [
    { port: 5173, address: 'any-v6', source: 'terminal', process: 'vite' },
    { port: 3000, address: 'loopback-v6', source: 'agent', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'terminal', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'agent', process: 'node' },
  ];
  const sorted = [...ports].sort(comparePorts);
  assert.deepEqual(sorted.map(port => `${port.port}:${port.address}:${port.source}`),
    ['3000:loopback-v4:agent', '3000:loopback-v4:terminal', '3000:loopback-v6:agent', '5173:any-v6:terminal']);
  assert.equal(isPortList({ ports: sorted, truncated: false, scannedAt: new Date().toISOString() }), true);
  assert.equal(processName('node'), 'node');
  assert.equal(processName('a'.repeat(16)), 'unknown');
  assert.equal(processName('nöde'), 'unknown');
});

test('port preview stays unadvertised and its routes are truthful until discovery is wired', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-port-preview-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [] });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Ports', capabilities: { taskExecution: false, eventReplay: true } },
    value => value === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  const descriptor = await (await fetch(`${url}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'portPreview' } })).json();
  assert.equal(descriptor.capabilities.portPreview, false);
  for (const path of [`/v1/tasks/${randomUUID()}/ports`, '/v1/projects/example/ports']) {
    const response = await fetch(`${url}${path}`, { headers });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal((await fetch(`${url}${path}`, { headers: { authorization: 'Bearer test' } })).status, 409, path);
    assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers })).status, 405, path);
    assert.equal((await fetch(`${url}${path}?scope=all`, { headers })).status, 404, path);
  }
});
