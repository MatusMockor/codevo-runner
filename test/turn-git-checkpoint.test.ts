import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, rename, access, open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileTurnChangesStore } from '../src/infrastructure/projects/turn-changes.js';
import { runTurnHelper } from '../src/infrastructure/projects/turn-capture-helper.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turn-git-regression-'));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const info = await stat(cwd);
  return { root, cwd, identity: { dev: info.dev, ino: info.ino }, store: new FileTurnChangesStore(join(root, 'state')), signal: new AbortController().signal };
}

test('a repository exceeding legacy 8 MiB retains compact checkpoints and lazy immutable text', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const contents = 'original line\n'.repeat(6000);
  await Promise.all(Array.from({ length: 128 }, (_, n) => writeFile(join(f.cwd, `file-${n}.txt`), contents)));
  const oldStarted = performance.now();
  await assert.rejects(runTurnHelper({ mode: 'capture', cwd: f.cwd, identity: f.identity }, f.signal));
  t.diagnostic(`Legacy rejects ${(Buffer.byteLength(contents) * 128 / 1048576).toFixed(1)} MiB in ${Math.round(performance.now() - oldStarted)} ms.`);
  const started = performance.now();
  await f.store.captureStart(id, f.cwd, f.identity, f.signal);
  t.diagnostic(`Git before checkpoint: ${Math.round(performance.now() - started)} ms.`);
  assert.ok((await stat(join(f.root, 'state', 'turn-changes', `${id}.start`))).size < 1024);
  await writeFile(join(f.cwd, 'file-0.txt'), 'agent line\n');
  await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
  assert.ok((await stat(join(f.root, 'state', 'turn-changes', `${id}.end`))).size < 1024);
  assert.equal((await f.store.summary(id)).state, 'ready');
  await writeFile(join(f.cwd, 'file-0.txt'), 'later user change\n');
  const diff = await f.store.diff(id, 'file-0.txt');
  assert.equal(diff.original.text, contents);
  assert.equal(diff.modified.text, 'agent line\n');
});

test('capture preserves HEAD, staging and conflict entries and never runs workspace filters', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: f.cwd });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: f.cwd });
  await writeFile(join(f.cwd, 'file'), 'committed\n');
  execFileSync('git', ['add', 'file'], { cwd: f.cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: f.cwd });
  await writeFile(join(f.cwd, 'file'), 'staged\n');
  execFileSync('git', ['add', 'file'], { cwd: f.cwd });
  const blob = execFileSync('git', ['rev-parse', ':file'], { cwd: f.cwd }).toString().trim();
  execFileSync('git', ['update-index', '--index-info'], { cwd: f.cwd, input: `0 ${'0'.repeat(40)}\tfile\n100644 ${blob} 1\tfile\n100644 ${blob} 2\tfile\n100644 ${blob} 3\tfile\n` });
  const beforeIndex = await readFile(join(f.cwd, '.git', 'index'));
  const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd });
  await writeFile(join(f.cwd, 'file'), 'dirty baseline\n');
  await writeFile(join(f.cwd, '.gitattributes'), '* filter=unsafe diff=unsafe\n');
  execFileSync('git', ['config', 'filter.unsafe.clean', 'false'], { cwd: f.cwd });
  execFileSync('git', ['config', 'filter.unsafe.required', 'true'], { cwd: f.cwd });
  execFileSync('git', ['config', 'diff.unsafe.textconv', 'false'], { cwd: f.cwd });
  await f.store.captureStart(id, f.cwd, f.identity, f.signal);
  await writeFile(join(f.cwd, 'file'), 'agent change\n');
  await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
  assert.equal((await f.store.summary(id)).state, 'ready');
  assert.deepEqual(await readFile(join(f.cwd, '.git', 'index')), beforeIndex);
  assert.deepEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }), beforeHead);
  assert.equal((await f.store.diff(id, 'file')).original.text, 'dirty baseline\n');
});

test('refs, Git-directory and workspace identity replacement fail closed after durable capture', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.store.captureStart(id, f.cwd, f.identity, f.signal);
  await writeFile(join(f.cwd, 'file'), 'agent\n');
  await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
  assert.equal((await f.store.summary(id)).state, 'ready');
  const afterRef = `refs/codevo/turns/${id}/after`;
  const after = execFileSync('git', ['rev-parse', afterRef], { cwd: f.cwd }).toString().trim();
  execFileSync('git', ['update-ref', '-d', afterRef], { cwd: f.cwd });
  assert.equal((await f.store.summary(id)).state, 'unavailable');
  execFileSync('git', ['update-ref', afterRef, after], { cwd: f.cwd });
  await rename(join(f.cwd, '.git'), join(f.cwd, '.saved-git'));
  execFileSync('git', ['init', '-q'], { cwd: f.cwd });
  assert.equal((await f.store.summary(id)).state, 'unavailable');
  await rm(join(f.cwd, '.git'), { recursive: true });
  await rename(join(f.cwd, '.saved-git'), join(f.cwd, '.git'));
  await rename(f.cwd, join(f.root, 'saved-repo')); await mkdir(f.cwd);
  assert.equal((await f.store.summary(id)).state, 'unavailable');
});

test('linked-worktree checkpoints use its pinned common repository without changing its index', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: f.cwd });
  const linked = join(f.root, 'linked');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: f.cwd });
  const info = await stat(linked); const identity = { dev: info.dev, ino: info.ino };
  const gitdir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: linked }).toString().trim();
  const index = await readFile(join(gitdir, 'index'));
  await writeFile(join(linked, 'file'), 'before\n');
  await f.store.captureStart(id, linked, identity, f.signal);
  await writeFile(join(linked, 'file'), 'after\n');
  await f.store.captureEnd(id, linked, identity, f.signal);
  assert.equal((await f.store.summary(id)).state, 'ready');
  assert.deepEqual(await readFile(join(gitdir, 'index')), index);
  assert.equal((await f.store.diff(id, 'file')).original.text, 'before\n');
});

test('legacy JSON start and complete records remain readable after upgrade', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, 'file'), 'legacy before\n');
  const snapshot = await runTurnHelper({ mode: 'capture', cwd: f.cwd, identity: f.identity }, f.signal);
  await mkdir(join(f.root, 'state', 'turn-changes'), { recursive: true });
  await writeFile(join(f.root, 'state', 'turn-changes', `${id}.start`), JSON.stringify({ cwd: f.cwd, identity: f.identity, snapshot }));
  await writeFile(join(f.cwd, 'file'), 'legacy after\n');
  await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
  assert.equal((await f.store.summary(id)).state, 'ready');
  assert.equal((await f.store.diff(id, 'file')).original.text, 'legacy before\n');
  const reopened = new FileTurnChangesStore(join(f.root, 'state'));
  assert.equal((await reopened.diff(id, 'file')).modified.text, 'legacy after\n');
});

test('cancelling a stopped Git descendant reaps it and removes the privately owned scratch', async t => {
  if (process.platform !== 'linux') return t.skip('Linux process ownership test.');
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, 'file'), 'before\n');
  const bin = join(f.root, 'bin'); await mkdir(bin);
  const marker = join(f.root, 'marker');
  const realGit = execFileSync('which', ['git']).toString().trim();
  await writeFile(join(bin, 'git'), `#!/usr/bin/python3\nimport os,sys,json,signal\nif 'hash-object' in sys.argv:\n path=sys.stdin.readline().strip()\n target=os.readlink(path)\n with open(${JSON.stringify(marker)},'w') as out: json.dump(dict(pid=os.getpid(),scratch=os.path.dirname(target)),out)\n os.kill(os.getpid(), signal.SIGSTOP)\nos.execv(${JSON.stringify(realGit)}, [${JSON.stringify(realGit)}]+sys.argv[1:])\n`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  const controller = new AbortController();
  try {
    const pending = f.store.captureStart(id, f.cwd, f.identity, controller.signal);
    let value: { pid: number; scratch: string } | undefined;
    for (let i = 0; i < 100; i++) {
      try { value = JSON.parse(await readFile(marker, 'utf8')) as typeof value; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(value, 'Git descendant reached the cancellation boundary');
    controller.abort(); await pending;
    assert.throws(() => process.kill(value.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(value.scratch), { code: 'ENOENT' });
    assert.equal((await f.store.summary(id)).state, 'unavailable');
  } finally { controller.abort(); process.env.PATH = previous; }
});


test('public capture failures do not expose workspace paths or raw OS errors', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const privatePath = join(f.root, 'private-missing-workspace');
  await f.store.captureStart(id, privatePath, f.identity, f.signal);
  const summary = await f.store.summary(id);
  assert.equal(summary.state, 'unavailable');
  assert.equal(summary.reason, 'Recorded changes could not be captured or loaded.');
  assert.ok(!summary.reason?.includes(f.root));
});

test('failed durable start/end publication compensates only its exact capture-owned refs', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, 'file'), 'before\n');
  const endId = randomUUID();
  await f.store.captureStart(endId, f.cwd, f.identity, f.signal);
  const root = join(f.root, 'state', 'turn-changes');
  execFileSync('mkfifo', [join(root, `${endId}.end`)]);
  await writeFile(join(f.cwd, 'file'), 'after\n');
  await f.store.captureEnd(endId, f.cwd, f.identity, f.signal);
  assert.ok(execFileSync('git', ['for-each-ref', '--format=%(refname)', `refs/codevo/turns/${endId}/before`], { cwd: f.cwd }).toString().trim());
  assert.equal(execFileSync('git', ['for-each-ref', '--format=%(refname)', `refs/codevo/turns/${endId}/after`], { cwd: f.cwd }).toString(), '');
  const startId = randomUUID();
  execFileSync('mkfifo', [join(root, `${startId}.start`)]);
  await f.store.captureStart(startId, f.cwd, f.identity, f.signal);
  assert.equal(execFileSync('git', ['for-each-ref', '--format=%(refname)', `refs/codevo/turns/${startId}`], { cwd: f.cwd }).toString(), '');
});


test('a directory sync failure after linking preserves both retained checkpoint publications', async t => {
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, 'file'), 'before\n');
  const handle = await open(join(f.root, 'prototype'), 'w');
  const prototype = Object.getPrototypeOf(handle) as { sync(this: FileHandle): Promise<void> };
  const original = prototype.sync;
  prototype.sync = async function(this: FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error('Injected post-link directory-sync failure');
    return original.call(this);
  };
  try {
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await writeFile(join(f.cwd, 'file'), 'after\n');
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
  } finally { prototype.sync = original; await handle.close(); }
  assert.equal((await f.store.summary(id)).state, 'ready');
  assert.equal((await f.store.diff(id, 'file')).original.text, 'before\n');
  assert.equal((await f.store.diff(id, 'file')).modified.text, 'after\n');
});

test('cancellation after ref publication uses the prepared OID journal to remove its owned ref', async t => {
  if (process.platform !== 'linux') return t.skip('Linux process ownership test.');
  const f = await fixture(); const id = randomUUID();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, 'file'), 'before\n');
  const bin = join(f.root, 'bin'); await mkdir(bin);
  const marker = join(f.root, 'ref-published');
  const realGit = execFileSync('which', ['git']).toString().trim();
  await writeFile(join(bin, 'git'), `#!/usr/bin/python3\nimport os,sys,signal,subprocess\nif 'update-ref' in sys.argv and '-d' not in sys.argv:\n result=subprocess.run([${JSON.stringify(realGit)}]+sys.argv[1:], pass_fds=tuple(int(key) for key in os.listdir('/proc/self/fd') if key.isdigit() and int(key)>2 and os.path.exists('/proc/self/fd/'+key)))\n if result.returncode: sys.exit(result.returncode)\n with open(${JSON.stringify(marker)}, 'w') as out: out.write(str(os.getpid()))\n os.kill(os.getpid(), signal.SIGSTOP)\nos.execv(${JSON.stringify(realGit)}, [${JSON.stringify(realGit)}]+sys.argv[1:])\n`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  const controller = new AbortController();
  try {
    const pending = f.store.captureStart(id, f.cwd, f.identity, controller.signal);
    let published = false;
    for (let i = 0; i < 100; i++) {
      try { await access(marker); published = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(published, 'Git published the exact turn ref before cancellation');
    controller.abort(); await pending;
    assert.equal(execFileSync(realGit, ['for-each-ref', '--format=%(refname)', `refs/codevo/turns/${id}`], { cwd: f.cwd }).toString(), '');
    assert.equal((await f.store.summary(id)).state, 'unavailable');
  } finally { controller.abort(); process.env.PATH = previous; }
});
