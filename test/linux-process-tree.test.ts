import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OBSERVATION_FAILURE_LIMIT, PROCESS_TREE_LIMIT } from '../src/domain/process-observation.js';
import { runInteractiveProcess } from '../src/infrastructure/execution/interactive-process.js';
import { LinuxProcessTree, type ProcReader } from '../src/infrastructure/execution/linux-process-tree.js';
import { runProcess } from '../src/infrastructure/execution/process-runner.js';

for (const reason of ['cancel', 'timeout', 'parent-exit'] as const) {
  test(`Linux ${reason} owns nested detached groups and leaves unrelated process alive`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codevo-detached-'));
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const abort = new AbortController();
    const leaf = `require('node:fs').writeFileSync('leaf.pid',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('orphan','bad'),1200);setInterval(()=>{},1000)`;
    const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'inherit'});setInterval(()=>{},1000)`;
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'inherit'});setTimeout(()=>console.log('ready'),400);${reason === 'parent-exit' ? 'setTimeout(()=>process.exit(0),550)' : 'setInterval(()=>{},1000)'}`;
    try {
      await writeFile(join(cwd, 'provider.cjs'), script);
      const result = await runProcess({ executable: process.execPath, args: [join(cwd, 'provider.cjs')], cwd, stdin: '', env: process.env,
        signal: abort.signal, timeoutMs: reason === 'timeout' ? 600 : 3000, outputBytes: 10000,
        onOutput: async () => { if (reason === 'cancel') abort.abort(); } });
      assert.equal(result.error, reason === 'cancel' ? 'cancelled' : reason === 'timeout' ? 'execution_timeout' : undefined);
      await new Promise(resolve => setTimeout(resolve, 1300));
      await assert.rejects(readFile(join(cwd, 'orphan')));
      const pid = Number(await readFile(join(cwd, 'leaf.pid'), 'utf8'));
      // A subreaper may retain a zombie briefly; it must no longer execute.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '));
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    } finally {
      abort.abort(); unrelated.kill('SIGKILL');
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('Linux cleanup failure takes precedence over cancellation', { skip: process.platform !== 'linux' }, async t => {
  patch(t, 'kill', original => function () { original.call(this); throw new Error('injected inspection failure'); });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const result = await runProcess({ executable: process.execPath, args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
    cwd: tmpdir(), stdin: '', env: process.env, signal: abort.signal, timeoutMs: 3000, outputBytes: 10000,
    onOutput: async () => { abort.abort(); } });
  assert.equal(result.error, 'process_cleanup_failed');
});

const SECRET = '/proc/4242/task/4242/children';
const errno = (code: string) => Object.assign(new Error(`${code}: no such process, open '${SECRET}'`), { code });
type FakeProcess = Readonly<{ parent: number; threads: Readonly<Record<string, string | Error>> | Error; stat?: Error }>;
type Patched = (this: LinuxProcessTree) => void;

function patch(t: TestContext, method: 'observe' | 'kill', replace: (original: Patched) => Patched): void {
  const original = LinuxProcessTree.prototype[method];
  t.after(() => { LinuxProcessTree.prototype[method] = original; });
  LinuxProcessTree.prototype[method] = replace(original);
}

function fakeProc(processes: Readonly<Record<number, FakeProcess>>): ProcReader {
  const find = (pid: string) => {
    const found = processes[Number(pid)];
    if (!found) throw errno('ENOENT');
    return found;
  };
  const threads = (pid: string) => {
    const value = find(pid).threads;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    read: path => {
      const stat = /^\/proc\/(\d+)\/stat$/.exec(path);
      const unreadable = stat ? find(stat[1]!).stat : undefined;
      if (unreadable) throw unreadable;
      if (stat) return `${stat[1]} (a b) c) S ${find(stat[1]!).parent} ${'0 '.repeat(17)}${Number(stat[1]) * 10}`;
      const children = /^\/proc\/(\d+)\/task\/(\d+)\/children$/.exec(path);
      const value = children ? threads(children[1]!)[children[2]!] : undefined;
      if (value === undefined) throw errno('ENOENT');
      if (value instanceof Error) throw value;
      return value;
    },
    list: path => Object.keys(threads(/^\/proc\/(\d+)\/task$/.exec(path)?.[1] ?? '')),
  };
}

test('process tree treats a process or thread that vanished with ESRCH as gone', () => {
  const tree = new LinuxProcessTree(100, fakeProc({
    100: { parent: 1, threads: { 100: '200 300 400\n', 101: errno('ESRCH'), 102: errno('ENOENT') } },
    200: { parent: 100, threads: errno('ESRCH') },
    300: { parent: 100, threads: { 300: '500\n' } },
    400: { parent: 100, threads: errno('ENOENT') },
    500: { parent: 300, threads: { 500: '' } },
  }));
  assert.doesNotThrow(() => tree.observe());
  assert.deepEqual(tree.snapshot(), [100, 200, 300, 400, 500].map(pid => ({ pid, start: String(pid * 10) })));
});

test('process tree still surfaces other /proc failures and the containment limit', () => {
  const failing = (threads: FakeProcess['threads']) => new LinuxProcessTree(100, fakeProc({ 100: { parent: 1, threads } }));
  assert.throws(() => failing({ 100: errno('EIO') }).observe(), { code: 'EIO' });
  assert.throws(() => failing(errno('EACCES')).observe(), { code: 'EACCES' });
  assert.throws(() => failing(Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [String(index + 1), '']))).observe(),
    { message: PROCESS_TREE_LIMIT });
});

for (const [surface, failing] of [
  ['children read', { parent: 100, threads: { 200: errno('EIO') } }],
  ['task listing', { parent: 100, threads: errno('EIO') }],
] as const) {
  test(`process tree keeps discovering past a node whose ${surface} fails and still reports the failure`, () => {
    const world: Record<number, FakeProcess> = {
      100: { parent: 1, threads: { 100: '200 300 400\n' } },
      200: failing,
      300: { parent: 100, threads: { 300: '500\n', 301: errno('EMFILE') } },
      400: { parent: 100, threads: { 400: '' } },
      500: { parent: 300, threads: { 500: '600\n' } },
      600: { parent: 500, threads: { 600: '' } },
    };
    const tree = new LinuxProcessTree(100, fakeProc(world));
    assert.throws(() => tree.observe(), { code: 'EIO' });
    settle(world);
    assert.deepEqual(tree.snapshot().map(owned => owned.pid), [100, 200, 300, 400, 500, 600]);
  });
}

const settle = (world: Record<number, FakeProcess>) => {
  for (const pid of Object.keys(world).map(Number)) world[pid] = { parent: world[pid]!.parent, threads: {} };
};

test('process tree keeps discovering past a child whose stat fails and still reports the failure', () => {
  const world: Record<number, FakeProcess> = {
    100: { parent: 1, threads: { 100: '200 300 400\n' } },
    200: { parent: 100, threads: { 200: '' }, stat: errno('EIO') },
    300: { parent: 100, threads: { 300: '500\n' } },
    400: { parent: 100, threads: { 400: '' } },
    500: { parent: 300, threads: { 500: '600\n' } },
    600: { parent: 500, threads: { 600: '' } },
  };
  const tree = new LinuxProcessTree(100, fakeProc(world));
  assert.throws(() => tree.observe(), { code: 'EIO' });
  settle(world);
  assert.deepEqual(tree.snapshot().map(owned => owned.pid), [100, 300, 400, 500, 600]);
});

test('process tree keeps an owned node whose stat becomes unreadable and walks the rest', () => {
  const world: Record<number, FakeProcess> = {
    100: { parent: 1, threads: { 100: '200 300\n' } },
    200: { parent: 100, threads: { 200: '700\n' } },
    300: { parent: 100, threads: { 300: '' } },
    500: { parent: 300, threads: { 500: '' } },
    700: { parent: 200, threads: { 700: '' } },
  };
  const tree = new LinuxProcessTree(100, fakeProc(world));
  assert.deepEqual(tree.snapshot().map(owned => owned.pid), [100, 200, 300, 700]);
  world[200] = { ...world[200]!, stat: errno('EIO') };
  world[300] = { parent: 100, threads: { 300: '500\n' } };
  assert.throws(() => tree.observe(), { code: 'EIO' });
  settle(world);
  assert.deepEqual(tree.snapshot().map(owned => owned.pid), [100, 200, 300, 700, 500]);
});

test('process tree reports a permanent failure ahead of an earlier transient one', () => {
  const failing = (first: FakeProcess['threads'], second: FakeProcess['threads']) => new LinuxProcessTree(100, fakeProc({
    100: { parent: 1, threads: { 100: '200 300\n' } },
    200: { parent: 100, threads: first },
    300: { parent: 100, threads: second },
  }));
  assert.throws(() => failing({ 200: errno('EIO') }, errno('EACCES')).observe(), { code: 'EACCES' });
  assert.throws(() => failing(errno('EACCES'), { 300: errno('EIO') }).observe(), { code: 'EACCES' });
  assert.throws(() => failing(errno('EPERM'), errno('EACCES')).observe(), { code: 'EPERM' });
});

type Run = (script: string, signal: AbortSignal, onOutput: (channel: string, text: string) => Promise<void>) => ReturnType<typeof runProcess>;
const RUNNERS: Readonly<Record<'batch' | 'interactive', Run>> = {
  batch: (script, signal, onOutput) => runProcess({ executable: process.execPath, args: ['-e', script], cwd: tmpdir(), stdin: '',
    env: process.env, signal, timeoutMs: 15000, outputBytes: 10000, onOutput }),
  interactive: (script, signal, onOutput) => runInteractiveProcess({ executable: process.execPath, args: ['-e', script], cwd: tmpdir(),
    env: process.env, signal, timeoutMs: 15000, onOutput }, { start: async () => {}, receive: async frame => frame.done ? { exitCode: 0 } : undefined }),
};
const COMPLETES = 'setTimeout(()=>{console.log(JSON.stringify({done:true}));process.exit(0)},700)';
const IDLES = 'setInterval(()=>{},1000)';
const LINUX = { skip: process.platform !== 'linux', timeout: 20000 };

async function launch(t: TestContext, run: Run, script: string, abort = new AbortController()) {
  const notes: string[] = [];
  t.after(() => abort.abort());
  const result = await run(script, abort.signal, async (channel, text) => { if (channel === 'stderr') notes.push(text); });
  return { result, notes };
}

async function observed(t: TestContext, run: Run, script: string, observe: (call: number, original: () => void) => void) {
  let calls = 0;
  patch(t, 'observe', original => function () { observe(++calls, () => original.call(this)); });
  return { ...await launch(t, run, script), calls };
}

async function spawnsFamily(t: TestContext, middleEnds: string, providerEnds: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'codevo-degraded-'));
  const file = (name: string) => JSON.stringify(join(cwd, name));
  const pid = (name: string) => {
    try { return /^\d+$/.exec(readFileSync(join(cwd, name), 'utf8'))?.[0]; } catch { return undefined; }
  };
  t.after(async () => {
    for (const stray of [pid('leaf.pid'), pid('blocked.pid')]) {
      try { if (stray) process.kill(Number(stray), 'SIGKILL'); } catch {}
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const leaf = `const fs=require('node:fs');fs.writeFileSync(${file('leaf.pid')},String(process.pid));setTimeout(()=>fs.writeFileSync(${file('orphan')},'bad'),3000);setInterval(()=>{},1000)`;
  const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});${middleEnds}`;
  const script = `const {spawn}=require('node:child_process');const blocked=spawn(process.execPath,['-e',${JSON.stringify(IDLES)}],{stdio:'ignore'});`
    + `require('node:fs').writeFileSync(${file('blocked.pid')},String(blocked.pid));`
    + `spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore'});${providerEnds}`;
  let blocked: string | undefined;
  return {
    script, orphan: join(cwd, 'orphan'),
    blocked: () => blocked ??= pid('blocked.pid'),
    leaf: async () => pid('leaf.pid'),
    assertLeafDead: async () => {
      const leafPid = pid('leaf.pid');
      assert.ok(leafPid);
      const stat = await readFile(`/proc/${leafPid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '));
    },
  };
}

function degradeReads(t: TestContext, fails: (path: string) => boolean): void {
  const degraded = new WeakSet<LinuxProcessTree>();
  const degrade = (tree: LinuxProcessTree) => {
    if (degraded.has(tree)) return;
    degraded.add(tree);
    const internals = tree as unknown as { proc: ProcReader };
    const real = internals.proc;
    const guard = (path: string) => { if (fails(path)) throw errno('EIO'); };
    internals.proc = { read: path => { guard(path); return real.read(path); }, list: path => { guard(path); return real.list(path); } };
  };
  for (const method of ['observe', 'kill'] as const) patch(t, method, original => function () { degrade(this); original.call(this); });
}

for (const [mode, run] of Object.entries(RUNNERS)) {
  test(`Linux ${mode} run survives a transient observation failure`, LINUX, async t => {
    const { result, notes, calls } = await observed(t, run, COMPLETES, (call, original) => {
      if (call <= 3) throw errno('EIO');
      original();
    });
    assert.deepEqual(result, { exitCode: 0 });
    assert.ok(calls > 3);
    assert.deepEqual(notes, ['[Codevo] Process tree observe failed; retrying (EIO).\n']);
  });

  test(`Linux ${mode} run fails after a bounded streak of observation failures`, LINUX, async t => {
    const { result, notes, calls } = await observed(t, run, IDLES, () => { throw errno('EIO'); });
    assert.equal(result.error, 'process_cleanup_failed');
    assert.equal(calls, OBSERVATION_FAILURE_LIMIT);
    assert.deepEqual(notes, ['[Codevo] Process tree observe failed; retrying (EIO).\n',
      `[Codevo] Process tree observe failed (EIO, ${OBSERVATION_FAILURE_LIMIT} consecutive).\n`]);
  });

  for (const [reason, error, cause] of [['the tree limit', new Error(PROCESS_TREE_LIMIT), PROCESS_TREE_LIMIT], ['a permanent errno', errno('EACCES'), 'EACCES']] as const) {
    test(`Linux ${mode} run fails immediately when observation hits ${reason}`, LINUX, async t => {
      const { result, notes, calls } = await observed(t, run, IDLES, () => { throw error; });
      assert.equal(result.error, 'process_cleanup_failed');
      assert.equal(calls, 1);
      assert.deepEqual(notes, [`[Codevo] Process tree observe failed (${cause}).\n`]);
    });
  }

  for (const surface of ['task', 'stat'] as const) {
    test(`Linux ${mode} run kills a detached descendant discovered while an unrelated node's ${surface} is unreadable`, LINUX, async t => {
      const family = await spawnsFamily(t, 'setTimeout(()=>process.exit(0),1000)', 'setTimeout(()=>process.exit(0),1600)');
      degradeReads(t, path => path === `/proc/${family.blocked()}/${surface}`);
      const { result, notes } = await launch(t, run, family.script);
      assert.equal(notes[0], '[Codevo] Process tree observe failed; retrying (EIO).\n');
      if (surface === 'task') {
        assert.equal(result.error, 'process_cleanup_failed');
        assert.deepEqual(notes.slice(1), ['[Codevo] Process tree kill failed (EIO).\n']);
      }
      await new Promise(resolve => setTimeout(resolve, 1900));
      await assert.rejects(readFile(family.orphan));
      await family.assertLeafDead();
    });
  }

  test(`Linux ${mode} final sweep keeps discovering past a process it cannot freeze`, LINUX, async t => {
    const family = await spawnsFamily(t, IDLES, IDLES);
    const prototype = LinuxProcessTree.prototype as unknown as { signal(identity: { pid: number }, signal: string): void };
    const original = prototype.signal;
    t.after(() => { prototype.signal = original; });
    prototype.signal = function (identity, signal) {
      if (signal === 'SIGSTOP' && String(identity.pid) === family.blocked()) throw errno('EPERM');
      original.call(this, identity, signal);
    };
    patch(t, 'observe', () => function () {});
    const abort = new AbortController();
    const running = launch(t, run, family.script, abort);
    for (let attempt = 0; attempt < 400 && !await family.leaf(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    abort.abort();
    const { result, notes } = await running;
    assert.equal(result.error, 'process_cleanup_failed');
    assert.deepEqual(notes, ['[Codevo] Process tree kill failed (EPERM).\n']);
    await new Promise(resolve => setTimeout(resolve, 300));
    await family.assertLeafDead();
  });

  test(`Linux ${mode} run reports a failed process tree attach`, LINUX, async t => {
    const prototype = LinuxProcessTree.prototype as unknown as { identity(pid: number): unknown };
    const original = prototype.identity;
    t.after(() => { prototype.identity = original; });
    prototype.identity = () => { throw errno('EACCES'); };
    const { result, notes } = await launch(t, run, IDLES);
    assert.equal(result.error, 'process_cleanup_failed');
    assert.deepEqual(notes, ['[Codevo] Process tree attach failed (EACCES).\n']);
  });

  test(`Linux ${mode} final kill failure still fails the run and is reported once`, LINUX, async t => {
    let calls = 0;
    patch(t, 'kill', original => function () { calls++; original.call(this); throw errno('EPERM'); });
    const { result, notes } = await launch(t, run, COMPLETES);
    assert.equal(result.error, 'process_cleanup_failed');
    assert.ok(calls > 1);
    assert.deepEqual(notes, ['[Codevo] Process tree kill failed (EPERM).\n']);
  });
}

test('Linux interactive cleanup failure takes precedence over cancellation', LINUX, async t => {
  patch(t, 'kill', original => function () { original.call(this); throw new Error('injected inspection failure'); });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const result = await runInteractiveProcess({ executable: process.execPath, args: ['-e', `console.log("{}");${IDLES}`], cwd: tmpdir(),
    env: process.env, signal: abort.signal, timeoutMs: 15000, onOutput: async () => {} },
    { start: async () => {}, receive: async () => { abort.abort(); return undefined; } });
  assert.deepEqual(result, { exitCode: null, error: 'process_cleanup_failed' });
});
