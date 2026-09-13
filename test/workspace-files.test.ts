import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { WORKSPACE_FILE_LIMITS } from '../src/domain/workspace-files.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
}
async function fixture(t: TestContext, initial: Readonly<Record<string, string | Buffer>> = { 'tracked.txt': 'original\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-workspace-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, 'init');
  for (const [path, text] of Object.entries(initial)) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await writeFile(join(source, path), text);
  }
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'initial');
  const project = { id: 'sample', name: 'Sample', path: source };
  const data = join(root, 'data');
  const workspace = new GitProjectWorkspace(data);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  return { root, source, project, data, workspace, taskId, cwd };
}

test('lists Git statuses and reads baseline/current content including rename and deleted files', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t, {
    'tracked.txt': 'original\n', 'deleted.txt': 'deleted original\n', 'renamed.txt': 'rename original\n', 'nested/gone.txt': 'nested original\n',
  });
  await writeFile(join(cwd, 'tracked.txt'), 'modified\n');
  await rm(join(cwd, 'deleted.txt'));
  await rm(join(cwd, 'nested'), { recursive: true });
  await git(cwd, 'mv', 'renamed.txt', 'new name.txt');
  await writeFile(join(cwd, 'added.txt'), 'staged\n');
  await git(cwd, 'add', 'added.txt');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked\n');
  const listing = await workspace.files(project, taskId);
  assert.equal(listing.truncated, false);
  assert.deepEqual([...listing.files].sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'added.txt', status: 'added' }, { path: 'deleted.txt', status: 'deleted' },
    { path: 'nested/gone.txt', status: 'deleted' }, { path: 'new name.txt', status: 'renamed', oldPath: 'renamed.txt' },
    { path: 'tracked.txt', status: 'modified' }, { path: 'untracked.txt', status: 'untracked' },
  ]);
  for (const [path, original, modified] of [
    ['added.txt', '', 'staged\n'], ['deleted.txt', 'deleted original\n', ''],
    ['nested/gone.txt', 'nested original\n', ''], ['new name.txt', 'rename original\n', 'rename original\n'],
    ['tracked.txt', 'original\n', 'modified\n'], ['untracked.txt', '', 'untracked\n'],
  ] as const) {
    assert.deepEqual(await workspace.fileDiff(project, taskId, path), {
      path, original: { text: original, truncated: false }, modified: { text: modified, truncated: false }, unavailableReason: null,
    });
  }
});

test('adapter restart retains original baseline across committed and pending turns', async t => {
  const { project, data, taskId, cwd } = await fixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'first turn\n');
  await git(cwd, 'commit', '-am', 'first turn');
  await writeFile(join(cwd, 'tracked.txt'), 'first turn\nsecond turn\n');
  const restarted = new GitProjectWorkspace(data);
  const diff = await restarted.fileDiff(project, taskId, 'tracked.txt');
  assert.equal(diff.original.text, 'original\n');
  assert.equal(diff.modified.text, 'first turn\nsecond turn\n');
  assert.deepEqual(await restarted.files(project, taskId), { files: [{ path: 'tracked.txt', status: 'modified' }], truncated: false });
});

for (const side of ['original', 'modified'] as const) {
  for (const kind of ['binary', 'large', 'invalid UTF-8'] as const) {
    test(`${kind} ${side} content is explicitly unavailable without leaking a partial text diff`, async t => {
      const content = kind === 'binary' ? Buffer.from([65, 0, 66]) : kind === 'large' ? Buffer.alloc(WORKSPACE_FILE_LIMITS.textBytes + 1, 65) : Buffer.from([0xc3, 0x28]);
      const { workspace, project, taskId, cwd } = await fixture(t, { 'tracked.txt': side === 'original' ? content : 'original\n' });
      await writeFile(join(cwd, 'tracked.txt'), side === 'modified' ? content : 'modified\n');
      const result = await workspace.fileDiff(project, taskId, 'tracked.txt');
      assert.deepEqual(result, {
        path: 'tracked.txt', original: { text: '', truncated: kind === 'large' }, modified: { text: '', truncated: kind === 'large' },
        unavailableReason: kind === 'large' ? 'large' : 'binary',
      });
    });
  }
}

test('unchanged and absent paths cannot be read through the changed-file endpoint', async t => {
  const { workspace, project, taskId } = await fixture(t);
  for (const path of ['tracked.txt', 'absent.txt']) await assert.rejects(workspace.fileDiff(project, taskId, path), { code: 'not_found' });
});

test('malformed paths fail closed before workspace access', async t => {
  const { workspace, project, taskId } = await fixture(t);
  for (const path of ['', '../secret', '/etc/passwd', 'C:/secret', 'a//b', './a', 'a/../b', '.git/config', 'a/.GiT/config', 'a\\b', 'a\0b', 'a\nb', 'a'.repeat(WORKSPACE_FILE_LIMITS.pathBytes + 1)]) {
    await assert.rejects(async () => workspace.fileDiff(project, taskId, path), { code: 'invalid_input' });
  }
});

test('nested symlink replacement never exposes outside file contents', async t => {
  const { workspace, project, taskId, cwd, root } = await fixture(t, { 'nested/file.txt': 'original\n' });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'file.txt'), 'outside secret\n');
  await rm(join(cwd, 'nested'), { recursive: true });
  await symlink(outside, join(cwd, 'nested'));
  await assert.rejects(workspace.fileDiff(project, taskId, 'nested/file.txt'), { code: 'conflict' });
});

for (const replacement of ['foreign repository', 'symlink'] as const) {
  test(`workspace replaced by ${replacement} rejects listing and content`, async t => {
    const { workspace, project, taskId, cwd, root } = await fixture(t);
    await rename(cwd, join(root, 'old-worktree'));
    if (replacement === 'symlink') await symlink(project.path, cwd);
    if (replacement === 'foreign repository') {
      await mkdir(cwd);
      await git(cwd, 'init');
      await writeFile(join(cwd, 'tracked.txt'), 'foreign secret\n');
    }
    await assert.rejects(workspace.files(project, taskId));
    await assert.rejects(workspace.fileDiff(project, taskId, 'tracked.txt'));
  });
}

test('large changed-file list exposes truncation and never exceeds its item budget', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t);
  for (let index = 0; index < WORKSPACE_FILE_LIMITS.files + 1; index++) await writeFile(join(cwd, `new-${index.toString().padStart(4, '0')}.txt`), 'new\n');
  const result = await workspace.files(project, taskId);
  assert.equal(result.files.length, WORKSPACE_FILE_LIMITS.files);
  assert.equal(result.truncated, true);
  assert.equal(new Set(result.files.map(file => file.path)).size, WORKSPACE_FILE_LIMITS.files);
  await assert.rejects(workspace.fileDiff(project, taskId, 'new-1000.txt'), { code: 'not_found' });
});

test('review concurrency is bounded and permits are released after success and failure', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'modified\n');
  const first = workspace.files(project, taskId);
  const second = workspace.fileDiff(project, taskId, 'tracked.txt');
  await assert.rejects(workspace.files(project, taskId), { code: 'busy' });
  await Promise.all([first, second]);
  await assert.rejects(workspace.fileDiff(project, taskId, 'missing.txt'), { code: 'not_found' });
  assert.equal((await workspace.files(project, taskId)).files.length, 1);
});

test('exact UTF-8 byte boundary remains readable and an emptied file is a complete diff', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t);
  const text = 'é'.repeat(WORKSPACE_FILE_LIMITS.textBytes / 2);
  await writeFile(join(cwd, 'tracked.txt'), text);
  const boundary = await workspace.fileDiff(project, taskId, 'tracked.txt');
  assert.equal(boundary.modified.text, text);
  assert.equal(boundary.modified.truncated, false);
  assert.equal(boundary.unavailableReason, null);
  await writeFile(join(cwd, 'tracked.txt'), '');
  const empty = await workspace.fileDiff(project, taskId, 'tracked.txt');
  assert.deepEqual(empty.modified, { text: '', truncated: false });
  assert.equal(empty.original.text, 'original\n');
  assert.equal(empty.unavailableReason, null);
});

test('an index deletion with a remaining untracked file produces one modified entry', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t);
  await git(cwd, 'rm', '--cached', 'tracked.txt');
  await writeFile(join(cwd, 'tracked.txt'), 'remaining working file\n');
  assert.deepEqual(await workspace.files(project, taskId), {
    files: [{ path: 'tracked.txt', status: 'modified' }], truncated: false,
  });
  assert.deepEqual(await workspace.fileDiff(project, taskId, 'tracked.txt'), {
    path: 'tracked.txt', original: { text: 'original\n', truncated: false },
    modified: { text: 'remaining working file\n', truncated: false }, unavailableReason: null,
  });
});

test('invalid UTF-8 tracked and untracked filenames are skipped without corrupting neighboring entries', async t => {
  const { workspace, project, taskId, cwd } = await fixture(t);
  const invalidTracked = Buffer.concat([Buffer.from(`${cwd}/tracked-`), Buffer.from([0xff]), Buffer.from('.txt')]);
  const invalidUntracked = Buffer.concat([Buffer.from(`${cwd}/untracked-`), Buffer.from([0xfe]), Buffer.from('.txt')]);
  try { await writeFile(invalidTracked, 'staged invalid filename\n'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EILSEQ') {
      t.skip('Host filesystem rejects invalid UTF-8 names; this regression runs on Linux');
      return;
    }
    throw error;
  }
  await git(cwd, 'add', '.');
  await writeFile(invalidUntracked, 'untracked invalid filename\n');
  await writeFile(join(cwd, 'valid.txt'), 'valid untracked file\n');
  await writeFile(join(cwd, 'tracked.txt'), 'valid modified file\n');
  const result = await workspace.files(project, taskId);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.files, [
    { path: 'tracked.txt', status: 'modified' }, { path: 'valid.txt', status: 'untracked' },
  ]);
  assert.equal((await workspace.fileDiff(project, taskId, 'valid.txt')).modified.text, 'valid untracked file\n');
});

for (const kind of ['oversized', 'FIFO'] as const) {
  test(`${kind} persisted baseline is rejected without blocking`, { timeout: 5000 }, async t => {
    const { data, project, taskId } = await fixture(t);
    const baseline = join(data, 'workspace-baselines', taskId);
    await rm(baseline);
    if (kind === 'oversized') await writeFile(baseline, 'a'.repeat(1024 * 1024));
    if (kind === 'FIFO') await exec('mkfifo', [baseline]);
    // A separate process bounds the regression even if a FIFO read blocks indefinitely.
    const moduleUrl = new URL('../src/infrastructure/projects/index.js', import.meta.url).href;
    const result = await exec(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { GitProjectWorkspace } = await import(process.argv[1]);
      const workspace = new GitProjectWorkspace(process.argv[2]);
      const project = JSON.parse(process.argv[3]);
      await assert.rejects(workspace.resume(project, process.argv[4]));
      await assert.rejects(workspace.files(project, process.argv[4]));
      await assert.rejects(workspace.fileDiff(project, process.argv[4], 'tracked.txt'));
      console.log('rejected');
    `, moduleUrl, data, JSON.stringify(project), taskId], { timeout: 3000 });
    assert.equal(result.stdout.trim(), 'rejected');
  });
}

test('legal leading BOM filename and baseline text retain their exact content', async t => {
  const path = '\ufefftracked.txt';
  const { workspace, project, taskId, cwd } = await fixture(t, { [path]: '\ufefforiginal\n' });
  await writeFile(join(cwd, path), '\ufeffmodified\n');
  assert.deepEqual(await workspace.files(project, taskId), { files: [{ path, status: 'modified' }], truncated: false });
  assert.deepEqual(await workspace.fileDiff(project, taskId, path), {
    path, original: { text: '\ufefforiginal\n', truncated: false },
    modified: { text: '\ufeffmodified\n', truncated: false }, unavailableReason: null,
  });
});
