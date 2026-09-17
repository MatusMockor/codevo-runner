import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { listSurfaceHistory, listSurfaceCommitFiles, readSurfaceCommitDiff } from '../src/infrastructure/projects/surface-history.js';
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args])).stdout.trim();
}
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'surface-history-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, 'init');
  await writeFile(join(cwd, 'first.txt'), 'hello\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'root');
  return { cwd, identity: await stat(cwd), signal: new AbortController().signal, root: await git(cwd, 'rev-parse', 'HEAD') };
}
test('history reads root addition and first-parent rename snapshots', async t => {
  const { cwd, identity, signal, root } = await fixture(t);
  assert.deepEqual(await listSurfaceCommitFiles(cwd, identity, { commit: root }, signal), { files: [{ path: 'first.txt', status: 'added' }], truncated: false });
  const first = await readSurfaceCommitDiff(cwd, identity, { commit: root, path: 'first.txt' }, signal);
  assert.equal(first.original.text, '');
  assert.equal(first.modified.text, 'hello\n');
  await git(cwd, 'mv', 'first.txt', 'renamed.txt');
  await git(cwd, 'commit', '-m', 'rename');
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  assert.deepEqual((await listSurfaceCommitFiles(cwd, identity, { commit }, signal)).files, [{ path: 'renamed.txt', oldPath: 'first.txt', status: 'renamed' }]);
  const diff = await readSurfaceCommitDiff(cwd, identity, { commit, path: 'renamed.txt' }, signal);
  assert.equal(diff.original.text, 'hello\n');
  assert.equal(diff.modified.text, 'hello\n');
  const history = await listSurfaceHistory(cwd, identity, { offset: 0 }, signal);
  assert.deepEqual(history.commits.map(item => [item.id, item.parents, item.subject]), [[commit, [root], 'rename'], [root, [], 'root']]);
  assert.equal(history.nextOffset, null);
  assert.equal(history.truncated, false);
});
test('rejects unrelated commit and non-member paths plus invalid input', async t => {
  const { cwd, identity, signal, root } = await fixture(t);
  await git(cwd, 'checkout', '--orphan', 'foreign');
  await git(cwd, 'commit', '-am', 'foreign');
  const foreign = await git(cwd, 'rev-parse', 'HEAD');
  await git(cwd, 'checkout', '--detach', root);
  await assert.rejects(listSurfaceCommitFiles(cwd, identity, { commit: foreign }, signal));
  for (const commit of ['HEAD', '--help', 'a'.repeat(39), 'A'.repeat(40)]) await assert.rejects(listSurfaceCommitFiles(cwd, identity, { commit }, signal));
  for (const path of ['../first.txt', '.git/config', '/first.txt', 'missing.txt']) await assert.rejects(readSurfaceCommitDiff(cwd, identity, { commit: root, path }, signal));
  for (const offset of [-1, 0.5, 100001, NaN]) await assert.rejects(listSurfaceHistory(cwd, identity, { offset }, signal));
  await assert.rejects(listSurfaceHistory(cwd, { dev: identity.dev, ino: identity.ino + 1 }, { offset: 0 }, signal));
});
test('large and binary blobs report unavailable and cancellation rejects', async t => {
  const { cwd, identity, signal } = await fixture(t);
  await writeFile(join(cwd, 'large.txt'), 'x'.repeat(65537));
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'blobs');
  const commit = await git(cwd, 'rev-parse', 'HEAD');
  assert.equal((await readSurfaceCommitDiff(cwd, identity, { commit, path: 'large.txt' }, signal)).unavailableReason, 'large');
  assert.equal((await readSurfaceCommitDiff(cwd, identity, { commit, path: 'binary' }, signal)).unavailableReason, 'binary');
  await assert.rejects(listSurfaceHistory(cwd, identity, { offset: 0 }, AbortSignal.abort()));
});
test('history paginates at fifty without claiming page limits are data truncation', async t => {
  const { cwd, identity, signal, root } = await fixture(t);
  const tree = await git(cwd, 'rev-parse', 'HEAD^{tree}');
  let parent = root;
  for (let index = 0; index < 50; index++) parent = await git(cwd, 'commit-tree', tree, '-p', parent, '-m', `commit ${index}`);
  await git(cwd, 'update-ref', 'HEAD', parent);
  const first = await listSurfaceHistory(cwd, identity, { offset: 0 }, signal);
  assert.equal(first.commits.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.truncated, false);
  const second = await listSurfaceHistory(cwd, identity, { offset: 50 }, signal);
  assert.deepEqual(second.commits.map(commit => commit.id), [root]);
  assert.equal(second.nextOffset, null);
});
