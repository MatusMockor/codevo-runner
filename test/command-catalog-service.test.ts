import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandCatalogService, COMMAND_CATALOG_POLICY, type CommandCatalogPolicy, type CommandCatalogWorkdir } from '../src/application/command-catalog-service.js';
import { RunnerError } from '../src/domain/contracts.js';
import type { CommandCatalog, CommandCatalogProvider } from '../src/domain/command-catalog.js';
import type { RegisteredProject } from '../src/domain/execution.js';

type Read = (provider: CommandCatalogProvider, workdir: CommandCatalogWorkdir, signal: AbortSignal) => Promise<unknown>;

function catalog(provider: CommandCatalogProvider, name: string): CommandCatalog {
  return { version: 1, provider, truncated: false,
    entries: [{ kind: provider === 'claudeCode' ? 'command' : 'skill', name, label: null, description: null, argumentHint: null, builtin: false }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const unavailable = { name: 'RunnerError', code: 'storage_unavailable' };
const names = (value: CommandCatalog) => value.entries.map(entry => entry.name);

function harness(policy: Partial<CommandCatalogPolicy> = {}, ids: readonly string[] = ['alpha', 'beta', 'gamma']) {
  const state = { now: 1_000_000, calls: [] as string[], checkouts: 0, revision: 1, read: undefined as Read | undefined };
  const projects = new Map<string, RegisteredProject>(ids.map(id => [id, { id, name: id, path: `/srv/${id}` }]));
  const service = new CommandCatalogService({
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
      const read = state.read ?? (async () => catalog(provider, `${workdir.cwd.slice(5)}-r${state.revision}`));
      return read(provider, workdir, signal) as Promise<CommandCatalog>;
    },
  }, { clock: () => state.now, policy });
  return { service, state, projects };
}

test('catalog policy defaults bound freshness, staleness, cached keys and concurrent probes', () => {
  assert.deepEqual(COMMAND_CATALOG_POLICY, { freshMs: 60_000, staleMs: 600_000, cachedKeys: 32, concurrentProbes: 2, checkoutMs: 5_000 });
});

test('registry and checkout failures are reported only as unavailable and a slow checkout is abandoned', async () => {
  const failing = (error: Error) => new CommandCatalogService({ get: async () => { throw error; } }, { checkout: async () => { throw new Error('unused'); } },
    { read: async () => { throw new Error('unused'); } });
  await assert.rejects(failing(new RunnerError('conflict')).read('alpha', 'codex'), unavailable);
  await assert.rejects(failing(new Error('sqlite /srv/private.db')).read('alpha', 'codex'), unavailable);
  await assert.rejects(failing(new RunnerError('not_found')).read('alpha', 'codex'), { name: 'RunnerError', code: 'not_found' });
  let reads = 0;
  const slow = new CommandCatalogService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, {
    checkout: (_project, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })),
  }, { read: async () => { reads++; throw new Error('unused'); } }, { policy: { checkoutMs: 30 } });
  const keepAlive = setInterval(() => {}, 1_000);
  try { await assert.rejects(slow.read('alpha', 'claudeCode'), unavailable); }
  finally { clearInterval(keepAlive); }
  const conflicted = new CommandCatalogService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, { checkout: async () => { throw new RunnerError('conflict'); } },
    { read: async () => { reads++; throw new Error('unused'); } });
  await assert.rejects(conflicted.read('alpha', 'claudeCode'), unavailable);
  assert.equal(reads, 0);
});

test('a checkout that outlives its deadline or shutdown releases its slot and never launches a provider', async () => {
  const late = deferred<CommandCatalogWorkdir>();
  const launched: string[] = [];
  const stalling = (policy: Partial<CommandCatalogPolicy>, stalled: Promise<CommandCatalogWorkdir>) => new CommandCatalogService(
    { get: async id => ({ id, name: id, path: `/srv/${id}` }) },
    { checkout: project => project.id === 'alpha' ? stalled : Promise.resolve({ cwd: project.path, identity: { dev: 1, ino: 1 } }) },
    { read: async (provider, workdir) => { launched.push(workdir.cwd); return catalog(provider, 'listed'); } }, { policy });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const service = stalling({ checkoutMs: 40, concurrentProbes: 1 }, late.promise);
    const started = Date.now();
    await assert.rejects(service.read('alpha', 'codex'), unavailable);
    assert.ok(Date.now() - started >= 30 && Date.now() - started < 5_000);
    assert.deepEqual(names(await service.read('beta', 'codex')), ['listed']);
    late.resolve({ cwd: '/srv/alpha', identity: { dev: 1, ino: 1 } });
    for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(launched, ['/srv/beta']);

    const closing = stalling({ checkoutMs: 60_000 }, new Promise(() => {}));
    const pending = assert.rejects(closing.read('alpha', 'claudeCode'), unavailable);
    await new Promise(resolve => setImmediate(resolve));
    await closing.close();
    await pending;
    assert.deepEqual(launched, ['/srv/beta']);
  } finally { clearInterval(keepAlive); }
});

test('a fresh catalog is served from cache per project and provider until it expires', async () => {
  const { service, state } = harness();
  const first = await service.read('alpha', 'claudeCode');
  state.revision = 2;
  state.now += 59_999;
  assert.equal(await service.read('alpha', 'claudeCode'), first);
  assert.deepEqual(state.calls, ['claudeCode:/srv/alpha']);
  assert.deepEqual(names(await service.read('alpha', 'codex')), ['alpha-r2']);
  state.now += 1;
  assert.deepEqual(names(await service.read('alpha', 'claudeCode')), ['alpha-r2']);
  assert.deepEqual(state.calls, ['claudeCode:/srv/alpha', 'codex:/srv/alpha', 'claudeCode:/srv/alpha']);
  assert.equal(state.checkouts, 3);
});

test('concurrent reads of one key share a single probe', async () => {
  const { service, state } = harness();
  const gate = deferred<CommandCatalog>();
  state.read = () => gate.promise;
  const reads = Array.from({ length: 6 }, () => service.read('alpha', 'codex'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.calls, ['codex:/srv/alpha']);
  gate.resolve(catalog('codex', 'shared'));
  const replies = await Promise.all(reads);
  for (const reply of replies) assert.equal(reply, replies[0]);
  assert.deepEqual(names(replies[0]!), ['shared']);
  assert.equal(await service.read('alpha', 'codex'), replies[0]);
  assert.deepEqual(state.calls, ['codex:/srv/alpha']);
});

test('a failed, invalid or foreign probe keeps the last good catalog and never caches the failure', async () => {
  const { service, state } = harness();
  state.read = async () => { throw new Error('secret /srv/alpha stderr'); };
  await assert.rejects(service.read('alpha', 'claudeCode'), unavailable);
  state.read = undefined;
  const good = await service.read('alpha', 'claudeCode');
  const failures: readonly Read[] = [
    async () => { throw new Error('probe failed'); },
    async () => catalog('codex', 'wrong-provider'),
    async () => ({ ...catalog('claudeCode', 'extra'), cwd: '/srv/alpha' }),
    async () => ({ ...catalog('claudeCode', 'bad'), entries: [{ name: 'bad name' }] }),
    async () => undefined,
  ];
  for (const failure of failures) {
    state.now += 60_000;
    state.read = failure;
    assert.equal(await service.read('alpha', 'claudeCode'), good);
  }
  assert.equal(state.calls.length, 2 + failures.length);
  state.read = undefined;
  state.revision = 2;
  assert.deepEqual(names(await service.read('alpha', 'claudeCode')), ['alpha-r2']);
  for (const failure of failures.slice(1)) {
    state.read = failure;
    await assert.rejects(service.read('beta', 'claudeCode'), unavailable);
  }
});

test('a last good catalog is not served once it is ten minutes stale', async () => {
  const { service, state } = harness();
  const good = await service.read('alpha', 'codex');
  state.read = async () => { throw new Error('probe failed'); };
  state.now += 599_999;
  assert.equal(await service.read('alpha', 'codex'), good);
  state.now += 1;
  await assert.rejects(service.read('alpha', 'codex'), unavailable);
  state.now -= 300_000;
  await assert.rejects(service.read('alpha', 'codex'), unavailable);
  state.read = undefined;
  state.revision = 2;
  assert.deepEqual(names(await service.read('alpha', 'codex')), ['alpha-r2']);
});

test('at most 32 keys are cached and the oldest fetch is evicted first', async () => {
  const ids = Array.from({ length: 34 }, (_, index) => `p${index}`);
  const { service, state } = harness({}, ids);
  for (const id of ids.slice(0, 32)) { await service.read(id, 'claudeCode'); state.now += 10; }
  state.now += 60_000;
  await service.read('p0', 'claudeCode');
  state.now += 10;
  await service.read('p32', 'claudeCode');
  await service.read('p33', 'codex');
  state.now += 60_000;
  state.read = async () => { throw new Error('probe failed'); };
  for (const id of ['p1', 'p2']) await assert.rejects(service.read(id, 'claudeCode'), unavailable);
  for (const id of ['p0', 'p3', 'p31', 'p32']) assert.deepEqual(names(await service.read(id, 'claudeCode')), [`${id}-r1`]);
  assert.deepEqual(names(await service.read('p33', 'codex')), ['p33-r1']);
  await assert.rejects(service.read('p33', 'claudeCode'), unavailable);
});

test('projects and providers never receive each other\'s catalog, including after a path change', async () => {
  const { service, state, projects } = harness();
  const gates = new Map<string, ReturnType<typeof deferred<CommandCatalog>>>();
  state.read = (provider, workdir) => {
    const gate = deferred<CommandCatalog>();
    gates.set(`${provider}:${workdir.cwd}`, gate);
    return gate.promise;
  };
  const alpha = service.read('alpha', 'claudeCode'), beta = service.read('beta', 'claudeCode');
  await new Promise(resolve => setImmediate(resolve));
  gates.get('claudeCode:/srv/beta')!.resolve(catalog('claudeCode', 'beta-only'));
  gates.get('claudeCode:/srv/alpha')!.resolve(catalog('claudeCode', 'alpha-only'));
  assert.deepEqual(names(await alpha), ['alpha-only']);
  assert.deepEqual(names(await beta), ['beta-only']);
  state.read = undefined;
  assert.deepEqual(names(await service.read('alpha', 'codex')), ['alpha-r1']);
  assert.deepEqual(names(await service.read('alpha', 'claudeCode')), ['alpha-only']);
  assert.deepEqual(names(await service.read('beta', 'claudeCode')), ['beta-only']);
  projects.set('alpha', { id: 'alpha', name: 'alpha', path: '/srv/moved' });
  assert.deepEqual(names(await service.read('alpha', 'claudeCode')), ['moved-r1']);
  projects.delete('beta');
  const calls = state.calls.length;
  await assert.rejects(service.read('beta', 'claudeCode'), { name: 'RunnerError', code: 'not_found' });
  for (const id of ['missing', '-bad', '../alpha', '', 'a'.repeat(65)]) await assert.rejects(service.read(id, 'codex'), { name: 'RunnerError', code: 'not_found' });
  assert.equal(state.calls.length, calls);
});

test('a third concurrent probe is refused as busy unless a last good catalog exists', async () => {
  const { service, state } = harness();
  const stale = await service.read('gamma', 'codex');
  state.now += 60_000;
  const gate = deferred<CommandCatalog>();
  state.read = (provider, workdir) => gate.promise.then(() => catalog(provider, workdir.cwd.slice(5)));
  const alpha = service.read('alpha', 'claudeCode'), beta = service.read('beta', 'claudeCode');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.read('alpha', 'codex'), { name: 'RunnerError', code: 'busy' });
  assert.equal(await service.read('gamma', 'codex'), stale);
  assert.equal(state.calls.length, 3);
  gate.resolve(catalog('codex', 'unused'));
  assert.deepEqual(names(await alpha), ['alpha']);
  assert.deepEqual(names(await beta), ['beta']);
  assert.deepEqual(names(await service.read('alpha', 'codex')), ['alpha']);
  assert.deepEqual(names(await service.read('gamma', 'codex')), ['gamma']);
  assert.equal(state.calls.length, 5);
});

test('close aborts pending probes, publishes nothing late and rejects new reads', async () => {
  const { service, state } = harness();
  const good = await service.read('beta', 'codex');
  assert.deepEqual(names(good), ['beta-r1']);
  state.now += 60_000;
  const signals: AbortSignal[] = [];
  const late = deferred<CommandCatalog>();
  state.read = (provider, _workdir, signal) => {
    signals.push(signal);
    if (provider === 'codex') return late.promise;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const aborted = assert.rejects(service.read('alpha', 'claudeCode'), unavailable);
  const published = assert.rejects(service.read('beta', 'codex'), unavailable);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 2);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  assert.ok(signals.every(signal => signal.aborted));
  await aborted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  late.resolve(catalog('codex', 'late'));
  await published;
  await closing;
  const calls = state.calls.length;
  await assert.rejects(service.read('beta', 'codex'), unavailable);
  await assert.rejects(service.read('missing', 'codex'), unavailable);
  assert.equal(state.calls.length, calls);
  await service.close();
});
