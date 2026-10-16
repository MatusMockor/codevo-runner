import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  McpDeviceSyncPreapprovals, type ClaudeLocalConfigReader, type McpDeviceSyncExecutor, type McpDeviceSyncLedgerRepository,
} from '../src/application/mcp-device-sync.js';
import { McpServerManagementService, type McpServerManagementPolicy } from '../src/application/mcp-server-management-service.js';
import type { McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { RunnerError } from '../src/domain/contracts.js';
import type { RegisteredProject } from '../src/domain/execution.js';
import {
  mcpDeviceLaunchDigest, parseClaudeStoredServer, type ClaudeStoredServers, type McpDeviceSyncLedger, type McpDeviceSyncStep,
} from '../src/domain/mcp-device-sync.js';

const SECRET = 'DEVICE_SYNC_SECRET';
const coded = (code: string) => ({ name: 'RunnerError', code });
const stdio = (command = 'npx', token = SECRET) => ({ kind: 'stdio', command, args: ['-y', 'server'], env: { TOKEN: token } });
const http = (token = SECRET) => ({ kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${token}` } });
const body = (servers: readonly unknown[], retain: readonly string[] = []) => ({ version: 1, servers, retain });
const stored = (value: unknown) => parseClaudeStoredServer(value);


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

class MemoryClaude implements ClaudeLocalConfigReader, McpDeviceSyncExecutor {
  readonly entries = new Map<string, unknown>();
  readonly log: string[] = [];
  readonly missing = new Set<string>();
  failing = new Set<string>();
  hold: ((step: McpDeviceSyncStep, signal: AbortSignal) => Promise<void>) | undefined;
  silentAdd = false;
  reads = 0;
  onRead: ((read: number) => Promise<void>) | undefined;
  onAvailable: (() => Promise<void>) | undefined;

  async read(_workdir: McpServersWorkdir, names: ReadonlySet<string>): Promise<ClaudeStoredServers> {
    this.reads++;
    await this.onRead?.(this.reads);
    return new Map([...this.entries].filter(([name]) => names.has(name)).map(([name, value]) => [name, stored(value)]));
  }

  async available(command: string): Promise<boolean> {
    await this.onAvailable?.();
    return !this.missing.has(command);
  }

  async run(step: McpDeviceSyncStep, workdir: McpServersWorkdir, signal: AbortSignal): Promise<boolean> {
    this.log.push(`${step.kind}:${step.name}:${workdir.cwd}`);
    await this.hold?.(step, signal);
    if (signal.aborted || this.failing.has(`${step.kind}:${step.name}`)) return false;
    if (step.kind === 'remove') {
      this.entries.delete(step.name);
      return true;
    }
    if (this.entries.has(step.name)) return false;
    if (!this.silentAdd) this.entries.set(step.name, JSON.parse(step.json));
    return true;
  }
}

class MemoryLedgers implements McpDeviceSyncLedgerRepository {
  readonly saved = new Map<string, ReadonlyMap<string, string>>();
  ledger: McpDeviceSyncLedger = { kind: 'valid', servers: new Map() };
  saves = 0;
  failSave = false;
  loadGate: Promise<void> | undefined;
  saveGate: Promise<void> | undefined;

  async load(): Promise<McpDeviceSyncLedger> {
    await this.loadGate;
    return this.ledger;
  }
  async save(projectId: string, servers: ReadonlyMap<string, string>): Promise<void> {
    this.saves++;
    await this.saveGate;
    if (this.failSave) throw new Error(`disk ${SECRET}`);
    this.saved.set(projectId, servers);
    this.ledger = { kind: 'valid', servers };
  }
}

function harness(t: TestContext, policy: Partial<McpServerManagementPolicy> = {}) {
  const claude = new MemoryClaude();
  const ledgers = new MemoryLedgers();
  const projects = new Map<string, RegisteredProject>(['alpha', 'beta'].map(id => [id, { id, name: id, path: `/srv/${id}` }]));
  const changes: string[] = [];
  const service = new McpServerManagementService({
    get: id => projects.has(id) ? Promise.resolve(projects.get(id)!) : Promise.reject(new RunnerError('not_found')),
  }, {
    async checkout(project) { return { cwd: project.path, identity: { dev: 1, ino: 1 } }; },
  }, {
    async change(_provider, change) { changes.push(change.kind); },
    login() { return Promise.reject(new Error('unused')); },
  }, { policy }, { config: claude, ledgers, executor: claude });
  t.after(() => service.close());
  return { service, claude, ledgers, changes };
}

test('a device sync adds, keeps and reports per name and persists only managed digests', async t => {
  const { service, claude, ledgers } = harness(t);
  claude.entries.set('own', { command: 'own' });
  claude.missing.add('/Users/me/bin/tool');
  assert.equal(service.supportsDeviceSync, true);
  const report = await service.syncDevice('alpha', 'claude', body([
    { name: 'docs', launch: stdio() }, { name: 'web', launch: http() }, { name: 'own', launch: stdio('different') },
    { name: 'mac', launch: stdio('/Users/me/bin/tool') },
  ], ['skipped']));
  assert.deepEqual(report, { version: 1, results: [
    { name: 'docs', outcome: 'added' }, { name: 'web', outcome: 'added' }, { name: 'own', outcome: 'keptServerEntry' }, { name: 'mac', outcome: 'commandMissing' },
  ] });
  assert.deepEqual(claude.log, ['add:docs:/srv/alpha', 'add:web:/srv/alpha']);
  assert.deepEqual(claude.entries.get('own'), { command: 'own' });
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()].sort(), ['docs', 'web']);
  assert.ok(!JSON.stringify([...ledgers.saved.get('alpha')!]).includes(SECRET));
  assert.equal(claude.reads, 2);

  claude.log.length = 0;
  const again = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio('npx', 'ROTATED') }]));
  assert.deepEqual(again.results, [{ name: 'docs', outcome: 'updated' }, { name: 'web', outcome: 'removed' }]);
  assert.deepEqual(claude.log, ['remove:docs:/srv/alpha', 'add:docs:/srv/alpha', 'remove:web:/srv/alpha']);
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], ['docs']);

  const saves = ledgers.saves;
  const steady = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio('npx', 'ROTATED') }]));
  assert.deepEqual(steady.results, [{ name: 'docs', outcome: 'unchanged' }]);
  assert.equal(ledgers.saves, saves);
});

test('an entry the CLI did not store under the expected key is reported failed', async t => {
  const { service, claude, ledgers } = harness(t);
  claude.silentAdd = true;
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]));
  assert.deepEqual(report.results, [{ name: 'docs', outcome: 'failed' }]);
  assert.equal(ledgers.ledger.kind === 'valid' && ledgers.ledger.servers.size, 0);
  claude.silentAdd = false;
  claude.failing.add('add:docs');
  assert.deepEqual((await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]))).results, [{ name: 'docs', outcome: 'failed' }]);
});

test('a corrupt ledger removes nothing and is replaced by the verified managed set', async t => {
  const { service, claude, ledgers } = harness(t);
  claude.entries.set('old', { command: 'npx' });
  ledgers.ledger = { kind: 'corrupt' };
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]));
  assert.deepEqual(report.results, [{ name: 'docs', outcome: 'added' }]);
  assert.ok(claude.entries.has('old'));
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], ['docs']);
});

test('the request is validated before lookup, Codex is unsupported and a disabled sync is not found', async t => {
  const { service, claude } = harness(t);
  await assert.rejects(service.syncDevice('missing', 'claude', { version: 1, servers: [], retain: [], extra: SECRET }), coded('invalid_input'));
  await assert.rejects(service.syncDevice('alpha', 'codex', body([{ name: 'docs', launch: stdio() }])), coded('mcp_change_unsupported'));
  await assert.rejects(service.syncDevice('missing', 'claude', body([])), coded('not_found'));
  await assert.rejects(service.syncDevice('../x', 'claude', body([])), coded('not_found'));
  assert.deepEqual(claude.log, []);
  const disabled = new McpServerManagementService({ get: () => Promise.reject(new Error('unused')) }, { checkout: () => Promise.reject(new Error('unused')) },
    { change: () => Promise.reject(new Error('unused')), login: () => Promise.reject(new Error('unused')) });
  t.after(() => disabled.close());
  assert.equal(disabled.supportsDeviceSync, false);
  await assert.rejects(disabled.syncDevice('alpha', 'claude', body([])), coded('not_found'));
});

test('a device sync shares the single change slot, counts as working and is busy while another change runs', async t => {
  const { service, claude, changes } = harness(t);
  const gate = deferred<void>();
  const entered = deferred<void>();
  claude.hold = async () => { entered.resolve(); await gate.promise; };
  const running = service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]));
  await entered.promise;
  assert.equal(service.working, true);
  await assert.rejects(service.syncDevice('beta', 'claude', body([])), coded('busy'));
  await assert.rejects(service.change('beta', 'claude', { change: { kind: 'remove', name: 'docs', scope: 'local' } }), coded('busy'));
  gate.resolve();
  assert.deepEqual((await running).results, [{ name: 'docs', outcome: 'added' }]);
  assert.equal(service.working, false);
  assert.deepEqual(changes, []);
});

test('the whole sync deadline stops further CLI runs and reports the rest failed', async t => {
  const { service, claude, ledgers } = harness(t, { deviceSyncMs: 200, deviceSyncSettleMs: 100 });
  claude.hold = async (step, signal) => {
    if (step.name !== 'second') return;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const report = await service.syncDevice('alpha', 'claude', body([
    { name: 'first', launch: stdio() }, { name: 'second', launch: stdio() }, { name: 'third', launch: stdio() },
  ]));
  assert.deepEqual(report.results, [{ name: 'first', outcome: 'added' }, { name: 'second', outcome: 'failed' }, { name: 'third', outcome: 'failed' }]);
  assert.deepEqual(claude.log, ['add:first:/srv/alpha', 'add:second:/srv/alpha']);
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], ['first']);
  assert.equal(service.working, false);
});

test('closing the service aborts a running sync without saving and reports storage_unavailable', async t => {
  const { service, claude, ledgers } = harness(t);
  const entered = deferred<void>();
  claude.hold = async (_step, signal) => {
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const running = service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]));
  await entered.promise;
  await service.close();
  await assert.rejects(running, coded('storage_unavailable'));
  assert.equal(ledgers.saves, 0);
  await assert.rejects(service.syncDevice('alpha', 'claude', body([])), coded('storage_unavailable'));
});

test('failures never carry secret values', async t => {
  const { service, ledgers } = harness(t);
  ledgers.failSave = true;
  try {
    await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: http() }]));
    assert.fail('expected a failure');
  } catch (error) {
    assert.deepEqual(error, new RunnerError('storage_unavailable'));
    assert.ok(!String((error as Error).message).includes(SECRET));
    assert.ok(!String((error as Error).stack).includes(SECRET));
  }
});

test('preapprovals read the config only when the ledger manages names and keep only matching copies', async () => {
  const claude = new MemoryClaude();
  const ledgers = new MemoryLedgers();
  const checkouts: string[] = [];
  const preapprovals = new McpDeviceSyncPreapprovals({ async checkout(project) { checkouts.push(project.path); return { cwd: project.path, identity: { dev: 1, ino: 1 } }; } },
    ledgers, claude);
  const project = { id: 'alpha', name: 'alpha', path: '/srv/alpha' };
  const live = new AbortController().signal;
  assert.deepEqual(await preapprovals.claudeServers(project, live), []);
  assert.equal(claude.reads, 0);
  assert.deepEqual(checkouts, []);
  claude.entries.set('docs', { command: 'npx' });
  claude.entries.set('edited', { command: 'changed' });
  claude.entries.set('own', { command: 'npx' });
  const digest = mcpDeviceLaunchDigest({ kind: 'stdio', command: 'npx', args: [], env: [] });
  ledgers.ledger = { kind: 'valid', servers: new Map([['docs', digest], ['edited', digest], ['gone', digest]]) };
  assert.deepEqual(await preapprovals.claudeServers(project, live), ['docs']);
  assert.deepEqual(checkouts, ['/srv/alpha']);
  ledgers.ledger = { kind: 'corrupt' };
  assert.deepEqual(await preapprovals.claudeServers(project, live), []);
  assert.equal(claude.reads, 1);
});

test('an operator edit made after planning is never removed and is reported as kept', async t => {
  const { service, claude, ledgers } = harness(t);
  await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }, { name: 'stale', launch: stdio() }]));
  claude.log.length = 0;
  claude.onAvailable = async () => {
    claude.entries.set('docs', { command: 'operator' });
    claude.entries.set('stale', { command: 'operator' });
  };
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio('npx', 'ROTATED') }]));
  assert.deepEqual(report.results, [{ name: 'docs', outcome: 'keptServerEntry' }, { name: 'stale', outcome: 'keptServerEntry' }]);
  assert.deepEqual(claude.log, []);
  assert.deepEqual(claude.entries.get('docs'), { command: 'operator' });
  assert.deepEqual(claude.entries.get('stale'), { command: 'operator' });
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], []);
});

test('an edit between an earlier CLI run and a later removal is detected right before the removal', async t => {
  const { service, claude } = harness(t);
  await service.syncDevice('alpha', 'claude', body([{ name: 'late', launch: stdio() }]));
  claude.log.length = 0;
  claude.hold = async step => { if (step.name === 'first') claude.entries.set('late', { command: 'operator' }); };
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'first', launch: stdio() }]));
  assert.deepEqual(report.results, [{ name: 'first', outcome: 'added' }, { name: 'late', outcome: 'keptServerEntry' }]);
  assert.deepEqual(claude.log, ['add:first:/srv/alpha']);
  assert.deepEqual(claude.entries.get('late'), { command: 'operator' });
});

async function settledSlot(service: McpServerManagementService): Promise<void> {
  const until = Date.now() + 5_000;
  while (service.working) {
    assert.ok(Date.now() < until, 'the change slot was never released');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const stall of ['ledger load', 'initial config read', 'command check'] as const) {
  test(`a stalled ${stall} answers within the deadline and holds the slot until the I/O settles`, async t => {
    const { service, claude, ledgers } = harness(t, { deviceSyncMs: 150, deviceSyncSettleMs: 50 });
    const gate = deferred<void>();
    if (stall === 'ledger load') ledgers.loadGate = gate.promise;
    if (stall === 'initial config read') claude.onRead = () => gate.promise;
    if (stall === 'command check') claude.onAvailable = () => gate.promise;
    const started = Date.now();
    const outcome = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }])).then(report => report, (error: unknown) => error);
    assert.ok(Date.now() - started < 2_000);
    if (stall === 'command check') assert.deepEqual(outcome, { version: 1, results: [{ name: 'docs', outcome: 'failed' }] });
    else assert.deepEqual(outcome, new RunnerError('storage_unavailable'));
    assert.deepEqual(claude.log, []);
    assert.equal(service.working, true);
    await assert.rejects(service.syncDevice('alpha', 'claude', body([])), coded('busy'));
    ledgers.loadGate = undefined;
    claude.onRead = undefined;
    claude.onAvailable = undefined;
    gate.resolve();
    await settledSlot(service);
    assert.deepEqual((await service.syncDevice('alpha', 'claude', body([]))).results, []);
  });
}

for (const stall of ['final config read', 'ledger save'] as const) {
  test(`a stalled ${stall} answers within the whole deadline and a late completion cannot race a newer sync`, async t => {
    const { service, claude, ledgers } = harness(t, { deviceSyncMs: 150, deviceSyncSettleMs: 50 });
    const gate = deferred<void>();
    if (stall === 'final config read') claude.onRead = async read => { if (read > 1) await gate.promise; };
    if (stall === 'ledger save') ledgers.saveGate = gate.promise;
    const started = Date.now();
    await assert.rejects(service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }])), coded('storage_unavailable'));
    assert.ok(Date.now() - started < 2_000);
    assert.equal(service.working, true);
    await assert.rejects(service.syncDevice('alpha', 'claude', body([])), coded('busy'));
    await assert.rejects(service.change('alpha', 'claude', { change: { kind: 'remove', name: 'docs', scope: 'local' } }), coded('busy'));
    claude.onRead = undefined;
    ledgers.saveGate = undefined;
    gate.resolve();
    await settledSlot(service);
    assert.deepEqual((await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }]))).results, [{ name: 'docs', outcome: 'unchanged' }]);
    assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], ['docs']);
  });
}

test('a transient config read failure before a removal removes nothing and keeps the name managed', async t => {
  const { service, claude, ledgers } = harness(t);
  await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio() }, { name: 'stale', launch: stdio() }]));
  const managed = ledgers.ledger.kind === 'valid' ? new Map(ledgers.ledger.servers) : new Map();
  claude.log.length = 0;
  claude.onRead = async read => { if (read === 2 || read === 3) throw new Error(`EIO ${SECRET}`); };
  claude.reads = 0;
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'docs', launch: stdio('npx', 'ROTATED') }]));
  assert.deepEqual(report.results, [{ name: 'docs', outcome: 'failed' }, { name: 'stale', outcome: 'failed' }]);
  assert.deepEqual(claude.log, []);
  assert.ok(claude.entries.has('docs') && claude.entries.has('stale'));
  assert.equal(ledgers.ledger.kind === 'valid' && ledgers.ledger.servers.size, 2);
  assert.deepEqual(ledgers.ledger.kind === 'valid' ? new Map(ledgers.ledger.servers) : null, managed);
});

test('the work phase stops before the settle reserve so applied changes are still reported', async t => {
  const { service, claude, ledgers } = harness(t, { deviceSyncMs: 300, deviceSyncSettleMs: 150 });
  claude.hold = async (step, signal) => {
    if (step.name !== 'second') return;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const report = await service.syncDevice('alpha', 'claude', body([{ name: 'first', launch: stdio() }, { name: 'second', launch: stdio() }]));
  assert.deepEqual(report.results, [{ name: 'first', outcome: 'added' }, { name: 'second', outcome: 'failed' }]);
  assert.deepEqual([...ledgers.saved.get('alpha')!.keys()], ['first']);
});
