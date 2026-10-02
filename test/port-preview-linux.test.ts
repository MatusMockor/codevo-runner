import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isPortList, type PortList } from '../src/domain/port-preview.js';
import { LinuxProcessTree } from '../src/infrastructure/execution/linux-process-tree.js';
import { ProcListeningPortScanner } from '../src/infrastructure/execution/listening-ports.js';
import { runProcess } from '../src/infrastructure/execution/process-runner.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const linuxOnly = { skip: process.platform !== 'linux', timeout: 30_000 };
const exec = promisify(execFile);
const LISTEN = (host: string, port = 0) => `const s=require('node:net').createServer().listen({host:${JSON.stringify(host)},port:${port}},()=>console.log('PORT='+s.address().port));setInterval(()=>{},1000)`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    last = await read();
    if (accept(last)) return last;
    await delay(100);
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

async function listener(host: string, parent = false): Promise<Readonly<{ child: ChildProcess; port: number }> | undefined> {
  const script = parent ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(LISTEN(host))}],{stdio:'inherit'});setInterval(()=>{},1000)` : LISTEN(host);
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let failed = false;
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', () => { failed = true; });
  for (let attempt = 0; attempt < 100 && !/PORT=\d+/.test(output) && !failed; attempt++) await delay(50);
  const port = /PORT=(\d+)/.exec(output)?.[1];
  if (port) return { child, port: Number(port) };
  kill(child);
  return undefined;
}

function kill(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already reaped. */ }
}

test('Linux scanner lists listeners of an owned process tree and never an unrelated process', linuxOnly, async t => {
  const owned = await listener('127.0.0.1', true);
  const unrelated = await listener('127.0.0.1');
  const any = await listener('0.0.0.0');
  t.after(() => { kill(owned?.child); kill(unrelated?.child); kill(any?.child); });
  assert.ok(owned && unrelated && any);
  const tree = new LinuxProcessTree(owned.child.pid!);
  const anyTree = new LinuxProcessTree(any.child.pid!);
  const scanner = new ProcListeningPortScanner();
  const scan = () => scanner.scan([
    { source: 'agent', processes: tree.snapshot(), complete: true },
    { source: 'terminal', processes: anyTree.snapshot(), complete: true },
  ], AbortSignal.timeout(2000));
  const listed = await eventually(scan, result => result.ports.length === 2, 'owned listeners');
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.ports.find(port => port.port === owned.port), { port: owned.port, address: 'loopback-v4', source: 'agent', process: 'node' });
  assert.deepEqual(listed.ports.find(port => port.port === any.port), { port: any.port, address: 'any-v4', source: 'terminal', process: 'node' });
  assert.equal(listed.ports.some(port => port.port === unrelated.port), false);
  kill(owned.child);
  await eventually(scan, result => !result.ports.some(port => port.port === owned.port), 'closed listener disappears');
});

test('Linux scanner reports IPv6 loopback and excludes a specific non-loopback bind', linuxOnly, async t => {
  const external = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  const v6 = await listener('::1');
  const specific = external ? await listener(external) : undefined;
  t.after(() => { kill(v6?.child); kill(specific?.child); });
  const owners = [v6, specific].flatMap(entry => entry ? [{ source: 'agent' as const, processes: new LinuxProcessTree(entry.child.pid!).snapshot(), complete: true }] : []);
  const result = await new ProcListeningPortScanner().scan(owners, AbortSignal.timeout(2000));
  if (v6) assert.deepEqual(result.ports.filter(port => port.port === v6.port), [{ port: v6.port, address: 'loopback-v6', source: 'agent', process: 'node' }]);
  if (specific) assert.equal(result.ports.some(port => port.port === specific.port), false);
  assert.ok(v6 || specific, 'neither IPv6 loopback nor an external IPv4 interface is available');
});

async function project(root: string): Promise<string> {
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'README.md'), 'ports\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  return source;
}

test('Linux port routes list a running turn and its conversation terminal, then drop them when they end', linuxOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-ports-linux-'));
  const release = join(root, 'release');
  const source = await project(root);
  const runnerId = randomUUID();
  let agentOutput = '';
  const runnerPort = await freePort();
  const provider = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(LISTEN('127.0.0.1', runnerPort))}],{stdio:'inherit'});` +
    `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(LISTEN('127.0.0.1'))}],{stdio:'inherit'});` +
    `setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},50)`;
  const services = await openRunnerServices(join(root, 'data'), runnerId, {
    projects: [{ id: 'project', name: 'Project', path: source }], listenPort: runnerPort,
    providers: [{ provider: 'claude', supportsAttachments: false, execute: request => runProcess({
      executable: process.execPath, args: ['-e', provider], cwd: request.cwd, stdin: '', env: process.env, signal: request.signal, timeoutMs: 20_000,
      ...(request.processes ? { processes: request.processes } : {}),
      onOutput: async (channel, text) => { if (channel === 'stdout') agentOutput += text; },
    }).then(result => ({ ...result, sessionId: randomUUID() })) }],
  });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Ports', capabilities: { taskExecution: false, eventReplay: true } },
    value => value === 'Bearer test', services);
  const unrelated = await listener('127.0.0.1');
  t.after(async () => { kill(unrelated?.child); await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.ok(unrelated);
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  const get = async (path: string) => {
    const response = await fetch(`${url}${path}`, { headers });
    return { status: response.status, body: await response.json() as PortList };
  };
  const descriptor = await (await fetch(`${url}/v1/runner`, { headers: { ...headers, 'x-codevo-client-capabilities': 'portPreview' } })).json();
  assert.equal(descriptor.capabilities.portPreview, true);

  const task = (await services.tasks.create({ idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Serve' }], provider: 'claude' })).task;
  await services.execution!.start(task.id, { projectId: 'project' });
  const agentPorts = await eventually(async () => [...agentOutput.matchAll(/PORT=(\d+)/g)].map(match => Number(match[1])), ports => ports.length === 2, 'agent ports');
  assert.ok(agentPorts.includes(runnerPort));
  const agentPort = agentPorts.find(port => port !== runnerPort)!;
  const listed = await eventually(() => get(`/v1/tasks/${task.id}/ports`), result => result.body.ports?.length === 1, 'agent listener');
  assert.equal(listed.status, 200);
  assert.equal(isPortList(listed.body), true);
  assert.deepEqual(listed.body.ports, [{ port: agentPort, address: 'loopback-v4', source: 'agent', process: 'node' }]);
  assert.equal(listed.body.truncated, false);

  const terminal = await services.terminals!.open('project', { cols: 80, rows: 24, taskId: task.id });
  await services.terminals!.input('project', terminal.id, { data: `exec ${process.execPath} -e ${JSON.stringify(LISTEN('127.0.0.1'))}\r` }, task.id);
  const terminalOutput = async () => (await services.terminals!.read('project', terminal.id, 0, task.id)).chunks.map(chunk => chunk.data).join('');
  let text = '';
  const terminalPort = await eventually(async () => { text = await terminalOutput(); return /PORT=(\d+)/.exec(text)?.[1]; }, value => value !== undefined, 'terminal port').then(Number);
  const both = await eventually(() => get(`/v1/tasks/${task.id}/ports`), result => result.body.ports?.length === 2, 'agent and terminal listeners');
  assert.deepEqual(both.body.ports.map(port => `${port.port}:${port.source}`).sort(), [`${agentPort}:agent`, `${terminalPort}:terminal`].sort());
  assert.ok(both.body.ports.every(port => port.port !== unrelated.port));
  assert.deepEqual((await get('/v1/projects/project/ports')).body.ports, []);

  const missing = await get(`/v1/tasks/${randomUUID()}/ports`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'not_found' });

  await writeFile(release, '');
  await eventually(() => services.tasks.get(task.id), current => !['queued', 'running'].includes(current.status), 'turn finished');
  const afterTurn = await eventually(() => get(`/v1/tasks/${task.id}/ports`), result => result.body.ports?.length === 1, 'agent listener removed');
  assert.deepEqual(afterTurn.body.ports.map(port => `${port.port}:${port.source}`), [`${terminalPort}:terminal`]);
  services.terminals!.closeSession('project', terminal.id, task.id);
  await eventually(() => get(`/v1/tasks/${task.id}/ports`), result => result.body.ports?.length === 0, 'terminal listener removed');
});

test('Linux project route lists the project terminal and not conversation listeners', linuxOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-ports-project-'));
  const source = await project(root);
  const services = await openRunnerServices(join(root, 'data'), randomUUID(), { projects: [{ id: 'project', name: 'Project', path: source }], providers: [] });
  t.after(async () => { await services.close(); await rm(root, { recursive: true, force: true }); });
  const terminal = await services.terminals!.open('project', { cols: 80, rows: 24 });
  await services.terminals!.input('project', terminal.id, { data: `exec ${process.execPath} -e ${JSON.stringify(LISTEN('127.0.0.1'))}\r` });
  const port = await eventually(async () => /PORT=(\d+)/.exec((await services.terminals!.read('project', terminal.id, 0)).chunks.map(chunk => chunk.data).join(''))?.[1],
    value => value !== undefined, 'project terminal port').then(Number);
  const listed = await eventually(() => services.ports!.projectPorts('project'), result => result.ports.length === 1, 'project terminal listener');
  assert.deepEqual(listed.ports, [{ port, address: 'loopback-v4', source: 'terminal', process: 'node' }]);
  services.terminals!.closeSession('project', terminal.id);
  await eventually(() => services.ports!.projectPorts('project'), result => result.ports.length === 0, 'project terminal listener removed');
});

for (const outcome of ['succeeded', 'failed'] as const) {
  test(`Linux turn ${outcome} releases its process ownership even when a tracked process outlives it`, linuxOnly, async t => {
    const root = await mkdtemp(join(tmpdir(), 'runner-ports-release-'));
    const release = join(root, 'release');
    const source = await project(root);
    const outliving = await listener('127.0.0.1');
    assert.ok(outliving);
    const services = await openRunnerServices(join(root, 'data'), randomUUID(), {
      projects: [{ id: 'project', name: 'Project', path: source }],
      providers: [{ provider: 'claude', supportsAttachments: false, execute: async request => {
        request.processes!.attach(new LinuxProcessTree(outliving.child.pid!));
        await eventually(async () => (await readdir(root)).includes('release'), value => value, 'release');
        if (outcome === 'failed') throw new Error('provider crashed');
        return { exitCode: 0, sessionId: randomUUID() };
      } }],
    });
    t.after(async () => { kill(outliving.child); await services.close(); await rm(root, { recursive: true, force: true }); });
    const task = (await services.tasks.create({ idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Serve' }], provider: 'claude' })).task;
    await services.execution!.start(task.id, { projectId: 'project' });
    const running = await eventually(() => services.ports!.taskPorts(task.id), result => result.ports.length === 1, 'tracked listener');
    assert.deepEqual(running.ports, [{ port: outliving.port, address: 'loopback-v4', source: 'agent', process: 'node' }]);
    await writeFile(release, '');
    const finished = await eventually(() => services.tasks.get(task.id), current => !['queued', 'running'].includes(current.status), 'turn finished');
    assert.equal(finished.status, outcome);
    await eventually(() => services.ports!.taskPorts(task.id), result => result.ports.length === 0, 'ownership released');
    assert.doesNotThrow(() => process.kill(outliving.child.pid!, 0));
  });
}
