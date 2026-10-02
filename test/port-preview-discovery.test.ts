import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPortList, portList, type ListeningPort } from '../src/domain/port-preview.js';
import { RunnerError, type Task } from '../src/domain/contracts.js';
import type { OwnedProcess, OwnedProcessTree } from '../src/domain/process-ownership.js';
import { classifyAddress, decodeAddress, parseTcpLine, parseTcpTable, socketInode } from '../src/infrastructure/execution/proc-net.js';
import { ProcListeningPortScanner } from '../src/infrastructure/execution/listening-ports.js';
import { ProcessOwnershipRegistry } from '../src/application/process-ownership.js';
import { PortPreviewService, type PortPreviewTasks } from '../src/application/port-preview-service.js';
import type { ListeningPortScanner, PortOwner, PortScan } from '../src/application/port-preview-ports.js';
import type { TerminalProcessOwner } from '../src/application/terminal-service.js';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const V6_HEADER = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';

function tcpLine(slot: number, local: string, state: string, inode: string): string {
  return `   ${slot}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
}

function tcp6Line(slot: number, local: string, state: string, inode: string): string {
  return `   ${slot}: ${local} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
}

test('proc net parser decodes little and big endian IPv4 and IPv6 bind addresses', () => {
  assert.deepEqual(decodeAddress('0100007F', 'LE'), [127, 0, 0, 1]);
  assert.deepEqual(decodeAddress('7F000001', 'BE'), [127, 0, 0, 1]);
  assert.equal(classifyAddress(decodeAddress('0100007F', 'LE'), 'v4'), 'loopback-v4');
  assert.equal(classifyAddress(decodeAddress('00000000', 'LE'), 'v4'), 'any-v4');
  assert.equal(classifyAddress(decodeAddress('0200007F', 'LE'), 'v4'), undefined);
  assert.equal(classifyAddress(decodeAddress('0F02000A', 'LE'), 'v4'), undefined);
  assert.equal(classifyAddress(decodeAddress('00000000000000000000000001000000', 'LE'), 'v6'), 'loopback-v6');
  assert.equal(classifyAddress(decodeAddress('00000000000000000000000000000001', 'BE'), 'v6'), 'loopback-v6');
  assert.equal(classifyAddress(decodeAddress('00000000000000000000000000000000', 'LE'), 'v6'), 'any-v6');
  assert.equal(classifyAddress(decodeAddress('0000000000000000FFFF00000100007F', 'LE'), 'v6'), 'loopback-v4');
  assert.equal(classifyAddress(decodeAddress('0000000000000000FFFF00000100000A', 'LE'), 'v6'), undefined);
  assert.equal(classifyAddress(decodeAddress('0000000000000000FFFF000000000000', 'LE'), 'v6'), undefined);
  assert.equal(classifyAddress(decodeAddress('000080FE00000000FF005450B6AD1DFE', 'LE'), 'v6'), undefined);
});

test('proc net parser keeps only well formed LISTEN rows and reads hexadecimal ports', () => {
  assert.deepEqual(parseTcpLine(tcpLine(0, '0100007F:0BB8', '0A', '12345'), 'v4', 'LE'), { inode: '12345', port: 3000, address: 'loopback-v4' });
  assert.deepEqual(parseTcpLine(tcpLine(1, '00000000:1435', '0A', '7'), 'v4', 'LE'), { inode: '7', port: 5173, address: 'any-v4' });
  assert.deepEqual(parseTcpLine(tcpLine(2, '7F000001:FFFF', '0A', '9'), 'v4', 'BE'), { inode: '9', port: 65535, address: 'loopback-v4' });
  assert.deepEqual(parseTcpLine(tcp6Line(0, '00000000000000000000000001000000:1F90', '0A', '42'), 'v6', 'LE'), { inode: '42', port: 8080, address: 'loopback-v6' });
  assert.deepEqual(parseTcp6Any(), { inode: '43', port: 8081, address: 'any-v6' });
  for (const [line, family] of [
    [tcpLine(0, '0100007F:0BB8', '01', '12345'), 'v4'],
    [tcpLine(0, '0100007F:0BB8', '0A', '0'), 'v4'],
    [tcpLine(0, '0100007F:0BB8', '0A', '01'), 'v4'],
    [tcpLine(0, '0100007F:0BB', '0A', '12345'), 'v4'],
    [tcpLine(0, '0100007G:0BB8', '0A', '12345'), 'v4'],
    [tcpLine(0, '00000000000000000000000001000000:0BB8', '0A', '12345'), 'v4'],
    [tcp6Line(0, '0100007F:0BB8', '0A', '12345'), 'v6'],
    [HEADER, 'v4'],
    ['   0: 0100007F:0BB8 00000000:0000 0A', 'v4'],
    ['', 'v4'],
  ] as const) assert.equal(parseTcpLine(line, family, 'LE'), undefined, line);
  assert.equal(socketInode('socket:[4026]'), '4026');
  for (const link of ['pipe:[4026]', 'socket:[]', 'socket:[01]', 'socket:[12]x', '/tmp/socket:[12]', 'anon_inode:[eventpoll]']) assert.equal(socketInode(link), undefined, link);
});

function parseTcp6Any() {
  return parseTcpLine(tcp6Line(1, '00000000000000000000000000000000:1F91', '0A', '43'), 'v6', 'LE');
}

test('proc net table skips the header and reports the line limit truthfully', () => {
  const text = HEADER + tcpLine(0, '0100007F:0BB8', '0A', '1') + tcpLine(1, '0100007F:0BB9', '0A', '2') + tcpLine(2, '0100007F:0BBA', '0A', '3');
  assert.deepEqual(parseTcpTable(text, 'v4', 'LE', 3), { listeners: [
    { inode: '1', port: 3000, address: 'loopback-v4' }, { inode: '2', port: 3001, address: 'loopback-v4' }, { inode: '3', port: 3002, address: 'loopback-v4' },
  ], truncated: false });
  const limited = parseTcpTable(text, 'v4', 'LE', 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.listeners.map(listener => listener.port), [3000, 3001]);
  assert.deepEqual(parseTcpTable(HEADER, 'v4', 'LE', 0), { listeners: [], truncated: false });
});

test('port list excludes privileged and runner ports, dedupes, orders strictly and caps truthfully', () => {
  const scannedAt = new Date().toISOString();
  const candidates: ListeningPort[] = [
    { port: 5173, address: 'any-v6', source: 'terminal', process: 'vite' },
    { port: 80, address: 'any-v4', source: 'agent', process: 'nginx' },
    { port: 1023, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 4318, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'agent', process: 'other' },
    { port: 3000, address: 'loopback-v4', source: 'terminal', process: 'nöde' },
    { port: 1024, address: 'loopback-v6', source: 'agent', process: 'node' },
  ];
  const list = portList(candidates, { excludedPorts: new Set([4318]), truncated: false, scannedAt });
  assert.deepEqual(list.ports, [
    { port: 1024, address: 'loopback-v6', source: 'agent', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 3000, address: 'loopback-v4', source: 'terminal', process: 'unknown' },
    { port: 5173, address: 'any-v6', source: 'terminal', process: 'vite' },
  ]);
  assert.equal(list.truncated, false);
  assert.equal(isPortList(list), true);
  const many = Array.from({ length: 40 }, (_, index): ListeningPort => ({ port: 9000 - index, address: 'loopback-v4', source: 'agent', process: 'node' }));
  const capped = portList(many, { excludedPorts: new Set(), truncated: false, scannedAt });
  assert.equal(capped.ports.length, 32);
  assert.equal(capped.truncated, true);
  assert.equal(capped.ports[0]!.port, 8961);
  assert.equal(isPortList(capped), true);
  assert.equal(portList([], { excludedPorts: new Set(), truncated: true, scannedAt }).truncated, true);
});

type FakeProcess = Readonly<{ pid: number; start: string; comm?: string; exe?: string; fds: Readonly<Record<string, string>> }>;

async function fakeProc(t: test.TestContext, processes: readonly FakeProcess[], tables: Readonly<{ tcp?: string; tcp6?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'runner-fake-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'net'));
  if (tables.tcp !== undefined) await writeFile(join(root, 'net', 'tcp'), tables.tcp);
  if (tables.tcp6 !== undefined) await writeFile(join(root, 'net', 'tcp6'), tables.tcp6);
  for (const entry of processes) {
    const directory = join(root, String(entry.pid));
    await mkdir(join(directory, 'fd'), { recursive: true });
    const fields = ['S', '1', ...Array.from({ length: 17 }, () => '0'), entry.start, '0'];
    await writeFile(join(directory, 'stat'), `${entry.pid} (${entry.comm ?? 'node'}) ${fields.join(' ')}\n`);
    await writeFile(join(directory, 'comm'), `${entry.comm ?? 'node'}\n`);
    if (entry.exe) await symlink(entry.exe, join(directory, 'exe'));
    for (const [fd, target] of Object.entries(entry.fds)) await symlink(target, join(directory, 'fd', fd));
  }
  return root;
}

const never = () => new AbortController().signal;
const owner = (source: 'agent' | 'terminal', processes: readonly OwnedProcess[], complete = true): PortOwner => ({ source, processes, complete });

test('proc scanner maps owned socket inodes to loopback and any-address listeners only', async t => {
  const root = await fakeProc(t, [
    { pid: 100, start: '500', comm: 'node', fds: { 0: '/dev/null', 3: 'socket:[11]', 4: 'socket:[12]', 5: 'socket:[13]', 6: 'pipe:[99]' } },
    { pid: 200, start: '600', comm: 'vite', fds: { 3: 'socket:[21]' } },
    { pid: 300, start: '700', comm: 'foreign', fds: { 3: 'socket:[31]' } },
    { pid: 400, start: '800', comm: 'MainThread', exe: '/usr/local/bin/node (deleted)', fds: { 3: 'socket:[41]' } },
    { pid: 500, start: '900', comm: 'MainThread', exe: '/opt/a-very-long-program-name', fds: { 3: 'socket:[51]' } },
  ], {
    tcp: HEADER + tcpLine(0, '0100007F:0BB8', '0A', '11') + tcpLine(1, '0F02000A:0BB9', '0A', '12') + tcpLine(2, '0100007F:0BBA', '01', '13') +
      tcpLine(3, '0100007F:1F90', '0A', '31') + tcpLine(4, '0100007F:2328', '0A', '41') + tcpLine(5, '0100007F:2329', '0A', '51'),
    tcp6: V6_HEADER + tcp6Line(0, '00000000000000000000000000000000:1435', '0A', '21'),
  });
  const scanner = new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' });
  const result = await scanner.scan([owner('agent', [{ pid: 100, start: '500' }, { pid: 400, start: '800' }, { pid: 500, start: '900' }]), owner('terminal', [{ pid: 200, start: '600' }])], never());
  assert.deepEqual(result, { ports: [
    { port: 3000, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 9000, address: 'loopback-v4', source: 'agent', process: 'node' },
    { port: 9001, address: 'loopback-v4', source: 'agent', process: 'MainThread' },
    { port: 5173, address: 'any-v6', source: 'terminal', process: 'vite' },
  ], truncated: false });
  assert.deepEqual(await scanner.scan([], never()), { ports: [], truncated: false });
});

test('proc scanner discards a recycled pid whose start time no longer matches', async t => {
  const root = await fakeProc(t, [{ pid: 100, start: '999', fds: { 3: 'socket:[11]' } }], { tcp: HEADER + tcpLine(0, '0100007F:0BB8', '0A', '11') });
  const scanner = new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' });
  assert.deepEqual(await scanner.scan([owner('agent', [{ pid: 100, start: '500' }])], never()), { ports: [], truncated: false });
  assert.deepEqual(await scanner.scan([owner('agent', [{ pid: 4242, start: '1' }])], never()), { ports: [], truncated: false });
});

test('proc scanner fd, table byte and line limits and incomplete ownership produce truncated', async t => {
  const fds = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 3), `socket:[${index + 11}]`]));
  const rows = Array.from({ length: 6 }, (_, index) => tcpLine(index, `0100007F:${(3000 + index).toString(16).toUpperCase().padStart(4, '0')}`, '0A', String(index + 11))).join('');
  const root = await fakeProc(t, [{ pid: 100, start: '500', fds }, { pid: 101, start: '501', fds: { 3: 'socket:[11]' } }], { tcp: HEADER + rows });
  const owned = [owner('agent', [{ pid: 100, start: '500' }])];
  const full = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' }).scan(owned, never());
  assert.equal(full.ports.length, 6);
  assert.equal(full.truncated, false);
  const perProcess = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE', limits: { fdsPerProcess: 2 } }).scan(owned, never());
  assert.deepEqual(perProcess.ports.map(port => port.port), [3000, 3001]);
  assert.equal(perProcess.truncated, true);
  const total = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE', limits: { fdsTotal: 6 } })
    .scan([owner('agent', [{ pid: 100, start: '500' }, { pid: 101, start: '501' }])], never());
  assert.equal(total.truncated, true);
  const lines = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE', limits: { tableLines: 3 } }).scan(owned, never());
  assert.deepEqual(lines.ports.map(port => port.port), [3000, 3001, 3002]);
  assert.equal(lines.truncated, true);
  const bytes = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE', limits: { tableBytes: HEADER.length + tcpLine(0, '0100007F:0BB8', '0A', '11').length + 10 } }).scan(owned, never());
  assert.deepEqual(bytes.ports.map(port => port.port), [3000]);
  assert.equal(bytes.truncated, true);
  const incomplete = await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' }).scan([owner('agent', [{ pid: 100, start: '500' }], false)], never());
  assert.equal(incomplete.truncated, true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' }).scan(owned, aborted.signal)).truncated, true);
});

test('process ownership leases expose only live attachments of their own conversation', () => {
  const registry = new ProcessOwnershipRegistry();
  const tree = (pid: number): OwnedProcessTree => ({ snapshot: () => [{ pid, start: '1' }] });
  const first = registry.open({ conversationId: 'a', projectId: 'p', isolation: 'worktree' });
  const second = registry.open({ conversationId: 'b', projectId: 'p', isolation: 'in-place' });
  const detach = first.attach(tree(1));
  second.attach(tree(2));
  assert.deepEqual(registry.conversation('a').trees.map(owned => owned.snapshot()[0]!.pid), [1]);
  assert.deepEqual(registry.inPlaceProject('p').trees.map(owned => owned.snapshot()[0]!.pid), [2]);
  assert.equal(registry.inPlaceProject('q').trees.length, 0);
  detach();
  assert.equal(registry.conversation('a').trees.length, 0);
  first.release();
  first.attach(tree(3));
  assert.equal(registry.conversation('a').trees.length, 0);
  for (let index = 0; index < 5; index++) second.attach(tree(10 + index));
  assert.equal(registry.conversation('b').complete, false);
  second.release();
  assert.deepEqual(registry.conversation('b'), { trees: [], complete: true });
});

const ROOT = '11111111-1111-4111-8111-111111111111';
const FOLLOW = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function tasks(): PortPreviewTasks {
  const rows: Record<string, { projectId: string; workspaceTaskId: string }> = {
    [ROOT]: { projectId: 'project', workspaceTaskId: ROOT },
    [FOLLOW]: { projectId: 'project', workspaceTaskId: ROOT },
    [OTHER]: { projectId: 'project', workspaceTaskId: OTHER },
  };
  const row = (id: string) => { const value = rows[id]; if (!value) throw new RunnerError('not_found'); return value; };
  return {
    async getTask(id) { return { id, projectId: row(id).projectId } as Task; },
    async getTaskSession(id) { return { workspaceTaskId: row(id).workspaceTaskId }; },
  };
}

class RecordingScanner implements ListeningPortScanner {
  calls: PortOwner[][] = [];
  gate: Promise<void> = Promise.resolve();
  async scan(owners: readonly PortOwner[]): Promise<PortScan> {
    this.calls.push([...owners]);
    await this.gate;
    return { ports: owners.flatMap(entry => entry.processes.map(process => ({ port: process.pid, address: 'loopback-v4' as const, source: entry.source, process: 'node' }))), truncated: false };
  }
}

function service(options: { clock?: () => number; terminals?: TerminalProcessOwner[]; registry?: ProcessOwnershipRegistry; scanner?: RecordingScanner } = {}) {
  const registry = options.registry ?? new ProcessOwnershipRegistry();
  const scanner = options.scanner ?? new RecordingScanner();
  const projects = { async get(id: string) { if (id !== 'project') throw new RunnerError('not_found'); return { id, name: 'Project', path: '/tmp' }; } };
  const ports = new PortPreviewService(tasks(), projects, registry, { processOwners: async projectId => projectId === 'project' ? options.terminals ?? [] : [] }, scanner,
    { excludedPorts: [4318], ...(options.clock ? { clock: options.clock } : {}) });
  return { ports, registry, scanner };
}

const tree = (...pids: number[]): OwnedProcessTree => ({ snapshot: () => pids.map(pid => ({ pid, start: '1' })) });

test('port preview resolves the exact conversation, its terminal and never foreign processes', async () => {
  const registry = new ProcessOwnershipRegistry();
  registry.open({ conversationId: ROOT, projectId: 'project', isolation: 'worktree' }).attach(tree(3000));
  registry.open({ conversationId: OTHER, projectId: 'project', isolation: 'worktree' }).attach(tree(3001));
  registry.open({ conversationId: 'in-place', projectId: 'project', isolation: 'in-place' }).attach(tree(3002));
  const terminals: TerminalProcessOwner[] = [
    { taskId: FOLLOW, tree: tree(5173) }, { taskId: OTHER, tree: tree(5174) }, { taskId: null, tree: tree(5175) },
  ];
  const { ports } = service({ registry, terminals });
  const listed = await ports.taskPorts(FOLLOW);
  assert.deepEqual(listed.ports.map(port => `${port.port}:${port.source}`), ['3000:agent', '5173:terminal']);
  assert.equal(isPortList(listed), true);
  assert.deepEqual((await ports.projectPorts('project')).ports.map(port => `${port.port}:${port.source}`), ['3002:agent', '5175:terminal']);
  await assert.rejects(ports.taskPorts(randomUUID()), (error: unknown) => error instanceof RunnerError && error.code === 'not_found');
  await assert.rejects(ports.taskPorts('not-a-task'), (error: unknown) => error instanceof RunnerError && error.code === 'invalid_input');
  await assert.rejects(ports.projectPorts('missing'), (error: unknown) => error instanceof RunnerError && error.code === 'not_found');
  await assert.rejects(ports.projectPorts('../x'), (error: unknown) => error instanceof RunnerError && error.code === 'invalid_input');
});

test('port preview excludes the runner port and reports failing tree snapshots as truncated', async () => {
  const registry = new ProcessOwnershipRegistry();
  const lease = registry.open({ conversationId: ROOT, projectId: 'project', isolation: 'worktree' });
  lease.attach(tree(4318, 3000));
  lease.attach({ snapshot: () => { throw new Error('process_tree_limit'); } });
  const listed = await service({ registry }).ports.taskPorts(ROOT);
  assert.deepEqual(listed.ports.map(port => port.port), [3000]);
  assert.equal(listed.truncated, true);
});

test('port preview caches per conversation for one second after the scan settles', async () => {
  let now = 1_000_000;
  const scanner = new RecordingScanner();
  const { ports } = service({ clock: () => now, scanner });
  await ports.taskPorts(ROOT);
  await ports.taskPorts(FOLLOW);
  assert.equal(scanner.calls.length, 1);
  now += 999;
  await ports.taskPorts(ROOT);
  assert.equal(scanner.calls.length, 1);
  now += 1;
  await ports.taskPorts(ROOT);
  assert.equal(scanner.calls.length, 2);
  await ports.taskPorts(OTHER);
  assert.equal(scanner.calls.length, 3);
});

test('port preview coalesces an in-flight scope and refuses scans beyond the concurrency bound', async () => {
  const scanner = new RecordingScanner();
  let release!: () => void;
  scanner.gate = new Promise(resolve => { release = resolve; });
  const ports = new PortPreviewService(tasks(), { async get(id: string) { return { id, name: 'Project', path: '/tmp' }; } }, new ProcessOwnershipRegistry(),
    { processOwners: async () => [] }, scanner, { limits: { concurrentScans: 2 } });
  const held = [ports.taskPorts(ROOT), ports.taskPorts(FOLLOW), ports.taskPorts(OTHER)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanner.calls.length, 2);
  await assert.rejects(ports.projectPorts('project'), (error: unknown) => error instanceof RunnerError && error.code === 'busy');
  release();
  await Promise.all(held);
  await ports.projectPorts('project');
  assert.equal(scanner.calls.length, 3);
});

function abortAfter(checks: number): AbortSignal {
  let seen = 0;
  return { get aborted() { seen++; return seen > checks; } } as AbortSignal;
}

test('proc scanner never hides a listener behind the deadline without reporting truncated', async t => {
  const root = await fakeProc(t, [{ pid: 100, start: '500', fds: { 3: 'socket:[11]' } }], { tcp: HEADER + tcpLine(0, '0100007F:0BB8', '0A', '11') });
  const scanner = new ProcListeningPortScanner({ procRoot: root, byteOrder: 'LE' });
  for (let checks = 0; checks < 16; checks++) {
    const result = await scanner.scan([owner('agent', [{ pid: 100, start: '500' }])], abortAfter(checks));
    assert.ok(result.truncated || result.ports.some(port => port.port === 3000), `abort after ${checks} checks: ${JSON.stringify(result)}`);
  }
});

class FlakyScanner extends RecordingScanner {
  failures: ('reject' | 'hang')[] = [];
  override async scan(owners: readonly PortOwner[]): Promise<PortScan> {
    const failure = this.failures.shift();
    this.calls.push([...owners]);
    if (failure === 'reject') throw new Error('proc unavailable');
    if (failure === 'hang') return new Promise<PortScan>(() => {});
    return { ports: [], truncated: false };
  }
}

function single(scanner: ListeningPortScanner, limits: Readonly<{ deadlineMs?: number; cachedScopes?: number }> = {}) {
  return new PortPreviewService(tasks(), { async get(id: string) { return { id, name: 'Project', path: '/tmp' }; } }, new ProcessOwnershipRegistry(),
    { processOwners: async () => [] }, scanner, { limits: { concurrentScans: 1, ...limits } });
}

test('a rejected scan is not cached and returns its concurrency slot', async () => {
  const scanner = new FlakyScanner();
  scanner.failures.push('reject');
  const ports = single(scanner);
  await assert.rejects(ports.taskPorts(ROOT), /proc unavailable/);
  assert.deepEqual((await ports.taskPorts(ROOT)).ports, []);
  await ports.taskPorts(OTHER);
  assert.equal(scanner.calls.length, 3);
});

test('a stalled scan settles as busy at the hard deadline and frees its slot', async () => {
  const scanner = new FlakyScanner();
  scanner.failures.push('hang');
  const ports = single(scanner, { deadlineMs: 20 });
  const started = Date.now();
  await assert.rejects(ports.taskPorts(ROOT), (error: unknown) => error instanceof RunnerError && error.code === 'busy');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual((await ports.taskPorts(OTHER)).ports, []);
  assert.deepEqual((await ports.taskPorts(ROOT)).ports, []);
});

test('the scope cache evicts the oldest settled scope at its bound', async () => {
  const scanner = new FlakyScanner();
  const ports = single(scanner, { cachedScopes: 2 });
  await ports.taskPorts(ROOT);
  await ports.taskPorts(OTHER);
  await ports.projectPorts('project');
  assert.equal(scanner.calls.length, 3);
  await ports.projectPorts('project');
  assert.equal(scanner.calls.length, 3);
  await ports.taskPorts(ROOT);
  assert.equal(scanner.calls.length, 4);
});
