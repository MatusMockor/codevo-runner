import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileTurnChangesStore } from '../src/infrastructure/projects/turn-changes.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turn-store-'));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const identity = await stat(cwd);
  return { root, cwd, identity: { dev: identity.dev, ino: identity.ino }, store: new FileTurnChangesStore(join(root, 'state')), signal: new AbortController().signal };
}

test('turn snapshots preserve dirty baseline, exact line counts, rename, executable changes and immutability', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await writeFile(join(f.cwd, 'edited'), 'user draft\nretained\n');
    await writeFile(join(f.cwd, 'renamed'), 'same\n');
    await writeFile(join(f.cwd, 'mode'), 'same\n', { mode: 0o600 });
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await writeFile(join(f.cwd, 'edited'), 'agent draft\nretained\nnew\n');
    await rename(join(f.cwd, 'renamed'), join(f.cwd, 'new-name'));
    await chmod(join(f.cwd, 'mode'), 0o700);
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    const summary = await f.store.summary(id);
    assert.equal(summary.state, 'ready');
    assert.deepEqual(summary.files.find(file => file.relativePath === 'edited'), { relativePath: 'edited', oldRelativePath: null, status: 'modified', addedLines: 2, deletedLines: 1 });
    assert.equal(summary.files.find(file => file.relativePath === 'new-name')?.status, 'renamed');
    assert.equal(summary.files.find(file => file.relativePath === 'mode')?.status, 'modified');
    assert.equal((await f.store.diff(id, 'edited')).original.text, 'user draft\nretained\n');
    await writeFile(join(f.cwd, 'edited'), 'later manual edit');
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    const reopened = new FileTurnChangesStore(join(f.root, 'state'));
    assert.deepEqual(await reopened.summary(id), summary);
    assert.equal((await reopened.diff(id, 'edited')).modified.text, 'agent draft\nretained\nnew\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('binary and large changed files have paired null counts and explicit unavailable diff', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await writeFile(join(f.cwd, 'binary'), Buffer.from([0,1,2]));
    await writeFile(join(f.cwd, 'large'), 'a'.repeat(131073));
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    const summary = await f.store.summary(id);
    assert.equal(summary.state, 'ready'); assert.equal(summary.files.length, 2);
    for (const file of summary.files) { assert.equal(file.addedLines, null); assert.equal(file.deletedLines, null); }
    assert.equal((await f.store.diff(id, 'binary')).unavailableReason, 'binary');
    assert.equal((await f.store.diff(id, 'large')).unavailableReason, 'large');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing baseline, symlink, stale root, cancellation and corrupt retention fail closed', async () => {
  const f = await fixture();
  try {
    const missing = randomUUID(); await f.store.captureEnd(missing, f.cwd, f.identity, f.signal);
    assert.equal((await f.store.summary(missing)).state, 'unavailable');
    await assert.rejects(f.store.diff(missing, '../escape'), /invalid_input/);
    const stale = randomUUID(); await f.store.captureStart(stale, f.cwd, { ...f.identity, ino: f.identity.ino + 1 }, f.signal);
    assert.equal((await f.store.summary(stale)).state, 'unavailable');
    await writeFile(join(f.root, 'outside'), 'secret'); await symlink(join(f.root, 'outside'), join(f.cwd, 'link'));
    const unsafe = randomUUID(); await f.store.captureStart(unsafe, f.cwd, f.identity, f.signal);
    assert.equal((await f.store.summary(unsafe)).state, 'unavailable');
    const cancelled = randomUUID(); const controller = new AbortController(); controller.abort();
    await f.store.captureStart(cancelled, f.cwd, f.identity, controller.signal);
    assert.equal((await f.store.summary(cancelled)).state, 'unavailable');
    const path = join(f.root, 'state', 'turn-changes', `${missing}.end`);
    const prior = await readFile(path, 'utf8');
    await writeFile(path, JSON.stringify({ summary: { turnId: missing, state: 'ready', files: 'malicious' }, diffs: [] }));
    assert.equal((await f.store.summary(missing)).state, 'unavailable');
    await writeFile(path, prior);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('changed-file limit is explicit and reads reject FIFO or replaced store root', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(f.cwd, `file-${index}`), 'new\n')));
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    const summary = await f.store.summary(id);
    assert.equal(summary.state, 'ready'); assert.equal(summary.truncated, true); assert.equal(summary.files.length, 500);
    assert.notEqual(summary.reason, null);
    const fifo = randomUUID();
    execFileSync('mkfifo', [join(f.root, 'state', 'turn-changes', `${fifo}.end`)]);
    assert.equal((await f.store.summary(fifo)).state, 'unavailable');
    await rename(join(f.root, 'state', 'turn-changes'), join(f.root, 'state', 'retained'));
    await mkdir(join(f.root, 'replacement'));
    await symlink(join(f.root, 'replacement'), join(f.root, 'state', 'turn-changes'));
    assert.equal((await f.store.summary(id)).state, 'unavailable');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('new ignore rules do not fabricate deletion of unchanged baseline files', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await writeFile(join(f.cwd, 'notes.txt'), 'unchanged user notes\n');
    await writeFile(join(f.cwd, 'removed.txt'), 'actually removed\n');
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await writeFile(join(f.cwd, '.gitignore'), 'notes.txt\nremoved.txt\n');
    await rm(join(f.cwd, 'removed.txt'));
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    const summary = await f.store.summary(id);
    assert.equal(summary.state, 'ready');
    assert.deepEqual(summary.files.map(file => file.relativePath), ['.gitignore', 'removed.txt']);
    assert.equal(summary.files[1]?.status, 'deleted');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('paths unsupported by editor contracts make snapshots explicitly unavailable rather than malformed', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await writeFile(join(f.cwd, 'valid'), 'baseline\n');
    await f.store.captureStart(id, f.cwd, f.identity, f.signal);
    await writeFile(join(f.cwd, 'name:unsupported'), 'changed\n');
    await f.store.captureEnd(id, f.cwd, f.identity, f.signal);
    assert.equal((await f.store.summary(id)).state, 'unavailable');
    assert.deepEqual((await f.store.summary(id)).files, []);
    for (const relativePath of ['name:unsupported', 'folder/.GiT/config', Array(65).fill('a').join('/')]) {
      await assert.rejects(f.store.diff(id, relativePath), { code: 'invalid_input' });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
