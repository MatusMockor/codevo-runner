import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_SERVERS_POLICY, McpServersService, type McpServersPolicy, type McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { RunnerError } from '../src/domain/contracts.js';
import type { RegisteredProject } from '../src/domain/execution.js';
import type { McpServers, McpServersProvider } from '../src/domain/mcp-servers.js';

type Read = (provider: McpServersProvider, workdir: McpServersWorkdir, signal: AbortSignal) => Promise<unknown>;

function snapshot(provider: McpServersProvider, name: string): McpServers {
  return { version: 1, provider, truncated: false,
    servers: [{ name, status: 'connected', scope: 'user', transport: 'stdio', endpointOrigin: null, toolCount: 1, detail: null }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const unavailable = { name: 'RunnerError', code: 'storage_unavailable' };
const missing = { name: 'RunnerError', code: 'not_found' };
const busy = { name: 'RunnerError', code: 'busy' };
const names = (value: McpServers) => value.servers.map(server => server.name);
const connected = () => new AbortController().signal;
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness(policy: Partial<McpServersPolicy> = {}, ids: readonly string[] = ['alpha', 'beta', 'gamma']) {
  const state = { calls: [] as string[], checkouts: 0, revision: 1, read: undefined as Read | undefined };
  const projects = new Map<string, RegisteredProject>(ids.map(id => [id, { id, name: id, path: `/srv/${id}` }]));
  const service = new McpServersService({
    async get(id) {
      const project = projects.get(id);
      if (!project) throw new RunnerError('not_found');
      return project;
    },
  }, {
    async checkout(project) {
      state.checkouts++;
      return { cwd: project.path, identity: { dev: 1, ino: project.path.length } };
    },
  }, {
    read(provider, workdir, signal) {
      state.calls.push(`${provider}:${workdir.cwd}`);
      const read = state.read ?? (async () => snapshot(provider, `${workdir.cwd.slice(5)}-r${state.revision}`));
      return read(provider, workdir, signal) as Promise<McpServers>;
    },
  }, { policy });
  return { service, state, projects };
}

test('MCP server policy caps concurrent probes at two and bounds checkout validation', () => {
  assert.deepEqual(MCP_SERVERS_POLICY, { concurrentProbes: 2, checkoutMs: 5_000 });
});

test('every read runs one fresh probe for exactly the registered project and provider', async () => {
  const { service, state, projects } = harness();
  assert.deepEqual(names(await service.read('alpha', 'claude', connected())), ['alpha-r1']);
  state.revision = 2;
  assert.deepEqual(names(await service.read('alpha', 'claude', connected())), ['alpha-r2']);
  assert.deepEqual(names(await service.read('alpha', 'codex', connected())), ['alpha-r2']);
  assert.deepEqual(names(await service.read('beta', 'codex', connected())), ['beta-r2']);
  projects.set('alpha', { id: 'alpha', name: 'alpha', path: '/srv/moved' });
  assert.deepEqual(names(await service.read('alpha', 'claude', connected())), ['moved-r2']);
  assert.deepEqual(state.calls, ['claude:/srv/alpha', 'claude:/srv/alpha', 'codex:/srv/alpha', 'codex:/srv/beta', 'claude:/srv/moved']);
  assert.equal(state.checkouts, 5);
});

test('unknown and malformed project ids are not found before any checkout or probe', async () => {
  const { service, state, projects } = harness();
  projects.delete('beta');
  for (const id of ['beta', 'missing', '-bad', '../alpha', '', 'a'.repeat(65), 'a/b']) await assert.rejects(service.read(id, 'codex', connected()), missing, id);
  assert.deepEqual([state.calls.length, state.checkouts], [0, 0]);
});

test('registry, checkout, probe and contract failures are reported only as unavailable and never retained', async () => {
  const failing = (error: Error) => new McpServersService({ get: async () => { throw error; } }, { checkout: async () => { throw new Error('unused'); } },
    { read: async () => { throw new Error('unused'); } });
  await assert.rejects(failing(new RunnerError('conflict')).read('alpha', 'codex', connected()), unavailable);
  await assert.rejects(failing(new Error('sqlite /srv/private.db')).read('alpha', 'codex', connected()), unavailable);
  await assert.rejects(failing(new RunnerError('not_found')).read('alpha', 'codex', connected()), missing);
  let reads = 0;
  const conflicted = new McpServersService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, { checkout: async () => { throw new RunnerError('conflict'); } },
    { read: async () => { reads++; throw new Error('unused'); } });
  await assert.rejects(conflicted.read('alpha', 'claude', connected()), unavailable);
  assert.equal(reads, 0);

  const { service, state } = harness({ concurrentProbes: 1 });
  const failures: readonly Read[] = [
    async () => { throw new Error('secret /srv/alpha stderr'); },
    async () => { throw new RunnerError('busy'); },
    async () => snapshot('codex', 'wrong-provider'),
    async () => ({ ...snapshot('claude', 'extra'), cwd: '/srv/alpha' }),
    async () => ({ ...snapshot('claude', 'bad'), servers: [{ name: 'bad', command: 'npx' }] }),
    async () => undefined,
  ];
  for (const failure of failures) {
    state.read = failure;
    await assert.rejects(service.read('alpha', 'claude', connected()), unavailable);
  }
  state.read = undefined;
  assert.deepEqual(names(await service.read('alpha', 'claude', connected())), ['alpha-r1']);
  assert.equal(state.calls.length, failures.length + 1);
});

test('a third concurrent probe is refused as busy and every slot is released on success and failure', async () => {
  const { service, state } = harness();
  const gates = new Map<string, ReturnType<typeof deferred<McpServers>>>();
  state.read = (provider, workdir) => {
    const gate = deferred<McpServers>();
    gates.set(`${provider}:${workdir.cwd}`, gate);
    return gate.promise;
  };
  const failing = service.read('alpha', 'claude', connected()), passing = service.read('alpha', 'codex', connected());
  await turn();
  assert.equal(state.calls.length, 2);
  await assert.rejects(service.read('beta', 'codex', connected()), busy);
  await assert.rejects(service.read('alpha', 'claude', connected()), busy);
  await assert.rejects(service.read('missing', 'codex', connected()), missing);
  assert.deepEqual([state.calls.length, state.checkouts], [2, 2]);
  gates.get('claude:/srv/alpha')!.reject(new Error('probe failed'));
  await assert.rejects(failing, unavailable);
  state.read = undefined;
  assert.deepEqual(names(await service.read('beta', 'claude', connected())), ['beta-r1']);
  gates.get('codex:/srv/alpha')!.resolve(snapshot('codex', 'alpha'));
  assert.deepEqual(names(await passing), ['alpha']);
  const pair = await Promise.all([service.read('alpha', 'codex', connected()), service.read('gamma', 'claude', connected())]);
  assert.deepEqual(pair.map(names), [['alpha-r1'], ['gamma-r1']]);
  assert.equal(state.calls.length, 5);
});

test('a checkout that outlives its deadline is abandoned, releases its slot and never launches a provider', async () => {
  const late = deferred<McpServersWorkdir>();
  const launched: string[] = [];
  const service = new McpServersService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) },
    { checkout: project => project.id === 'alpha' ? late.promise : Promise.resolve({ cwd: project.path, identity: { dev: 1, ino: 1 } }) },
    { read: async (provider, workdir) => { launched.push(workdir.cwd); return snapshot(provider, 'listed'); } }, { policy: { checkoutMs: 40, concurrentProbes: 1 } });
  const started = Date.now();
  await assert.rejects(service.read('alpha', 'codex', connected()), unavailable);
  assert.ok(Date.now() - started >= 30 && Date.now() - started < 5_000);
  assert.deepEqual(names(await service.read('beta', 'codex', connected())), ['listed']);
  late.resolve({ cwd: '/srv/alpha', identity: { dev: 1, ino: 1 } });
  for (let turns = 0; turns < 3; turns++) await turn();
  assert.deepEqual(launched, ['/srv/beta']);
});

test('a client disconnect aborts only its own probe and an already disconnected client launches nothing', async () => {
  const { service, state } = harness();
  const signals = new Map<string, AbortSignal>();
  state.read = (provider, workdir, signal) => {
    signals.set(workdir.cwd, signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (workdir.cwd === '/srv/beta') setTimeout(() => resolve(snapshot(provider, 'beta')), 30);
    });
  };
  const client = new AbortController();
  const dropped = assert.rejects(service.read('alpha', 'claude', client.signal), unavailable);
  const kept = service.read('beta', 'claude', connected());
  await turn();
  client.abort();
  await dropped;
  assert.deepEqual([signals.get('/srv/alpha')?.aborted, signals.get('/srv/beta')?.aborted], [true, false]);
  assert.deepEqual(names(await kept), ['beta']);
  await assert.rejects(service.read('gamma', 'claude', client.signal), unavailable);
  assert.deepEqual(state.calls, ['claude:/srv/alpha', 'claude:/srv/beta']);

  const late = harness();
  const gone = new AbortController();
  late.state.read = async provider => { gone.abort(); return snapshot(provider, 'late'); };
  await assert.rejects(late.service.read('alpha', 'codex', gone.signal), unavailable);
});

test('close aborts pending probes, waits for them, publishes nothing late and rejects new reads', async () => {
  const { service, state } = harness();
  const signals: AbortSignal[] = [];
  const late = deferred<McpServers>();
  state.read = (provider, _workdir, signal) => {
    signals.push(signal);
    if (provider === 'codex') return late.promise;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const aborted = assert.rejects(service.read('alpha', 'claude', connected()), unavailable);
  const published = assert.rejects(service.read('beta', 'codex', connected()), unavailable);
  await turn();
  assert.equal(signals.length, 2);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  assert.ok(signals.every(signal => signal.aborted));
  await aborted;
  await turn();
  assert.equal(closed, false);
  late.resolve(snapshot('codex', 'late'));
  await published;
  await closing;
  const calls = state.calls.length;
  await assert.rejects(service.read('beta', 'codex', connected()), unavailable);
  await assert.rejects(service.read('missing', 'codex', connected()), unavailable);
  assert.equal(state.calls.length, calls);
  await service.close();
});
