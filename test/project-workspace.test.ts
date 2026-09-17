import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from '../src/infrastructure/projects/index.js';

const exec = promisify(execFile);
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: source });
  await git('init');
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await git('add', '.');
  await git('commit', '-m', 'initial');
  const registry = new ConfiguredProjectRegistry([{ id:'example', name:'Example', path:source }]);
  const project = await registry.get('example');
  const workspace = new GitProjectWorkspace(join(root, 'data'));
  return { root, source, git, registry, project, workspace };
}

test('registered project IDs hide paths and reject arbitrary roots', async t => {
  const { registry, source } = await fixture(t);
  assert.deepEqual(await registry.list(), [{ id:'example', name:'Example' }]);
  await assert.rejects(registry.get(source), /not_found/);
  assert.throws(() => new ConfiguredProjectRegistry([{ id:'../escape', name:'Bad', path:source }]));
});

test('task edits and commits remain isolated and diff survives adapter restart', async t => {
  const { workspace, project, source, root } = await fixture(t);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  await writeFile(join(cwd, 'tracked.txt'), 'task edit\n');
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'task commit'], { cwd });
  await writeFile(join(cwd, 'new.txt'), 'untracked\n');
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'original\n');
  const restarted = new GitProjectWorkspace(join(root, 'data'));
  const diff = await restarted.diff(taskId);
  assert.match(diff.patch, /\+task edit/);
  assert.deepEqual(diff.untrackedFiles, ['new.txt']);
  assert.equal(diff.truncated, false);
  await assert.rejects(workspace.prepare(project, taskId), /conflict/);
});

test('checkout disables repository hooks and does not reuse dirty source files', async t => {
  const { workspace, project, source, root, git } = await fixture(t);
  const hooks = join(root, 'hooks');
  await mkdir(hooks);
  const marker = join(root, 'hook-ran');
  await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode:0o700 });
  await git('config', 'core.hooksPath', hooks);
  await writeFile(join(source, 'tracked.txt'), 'local pending edit\n');
  const cwd = await workspace.prepare(project, randomUUID());
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'original\n');
  await assert.rejects(readFile(marker), { code:'ENOENT' });
});

test('rejects traversal, symlink workspaces and cancelled preparation', async t => {
  const { workspace, project, root } = await fixture(t);
  await assert.rejects(workspace.prepare(project, '../escape'), /invalid_input/);
  await assert.rejects(workspace.diff('../escape'), /invalid_input/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.prepare(project, randomUUID(), controller.signal), { name:'AbortError' });
  await mkdir(join(root, 'data'));
  await symlink(join(root, 'source'), join(root, 'data', 'workspaces'));
  await assert.rejects(workspace.prepare(project, randomUUID()), /symlink/);
});

test('diff output is bounded for large task edits and disables external diff', async t => {
  const { workspace, project, git, root } = await fixture(t);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  const marker = join(root, 'diff-ran');
  await git('config', 'diff.external', `touch ${marker}`);
  await writeFile(join(cwd, 'tracked.txt'), 'long line\n'.repeat(100_000));
  const diff = await workspace.diff(taskId);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.patch) <= 256 * 1024);
  await assert.rejects(readFile(marker), { code:'ENOENT' });
});

for (const redirection of ['>/dev/null 2>&1', '>&2']) {
  test(`normal Git exit stops background filter descendants (${redirection})`, { timeout: 10_000 }, async t => {
    const { workspace, project, root, source, git } = await fixture(t);
    const marker = join(root, 'filter-child.pid');
    const filter = join(root, 'smudge.sh');
    await writeFile(filter, `#!/bin/sh\nsleep 120 ${redirection} &\necho $! > '${marker}'\ncat\n`, { mode: 0o700 });
    await writeFile(join(source, '.gitattributes'), 'tracked.txt filter=background\n');
    await git('add', '.gitattributes');
    await git('commit', '-m', 'configure filter attributes');
    await git('config', 'filter.background.smudge', filter);
    let pid: number | undefined;
    t.after(async () => {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    });
    await workspace.prepare(project, randomUUID());
    pid = Number((await readFile(marker, 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'stat=']);
        if (stdout.trim().startsWith('Z')) return; // Dead, awaiting OS reaping.
      } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Git filter descendant remains alive after prepare resolved');
  });
}


test('in-place preserves dirty and untracked source files, resumes after restart and reviews original baseline', async t => {
  const { workspace, project, source, root, git } = await fixture(t);
  await writeFile(join(source, 'tracked.txt'), 'dirty before task\n');
  await writeFile(join(source, 'keep.txt'), 'private local file\n');
  const taskId = randomUUID();
  assert.equal(await workspace.prepare(project, taskId, undefined, 'in-place'), await realpath(source));
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'dirty before task\n');
  assert.equal(await readFile(join(source, 'keep.txt'), 'utf8'), 'private local file\n');
  await git('commit', '-am', 'task edit');
  const restarted = new GitProjectWorkspace(join(root, 'data'));
  assert.equal(await restarted.resume(project, taskId), await realpath(source));
  assert.match((await restarted.diff(taskId)).patch, /dirty before task/);
  const files = await restarted.files(project, taskId);
  assert.ok(JSON.stringify(files).includes('tracked.txt'));
  assert.ok(JSON.stringify(await restarted.fileDiff(project, taskId, 'tracked.txt')).includes('dirty before task'));
  await assert.rejects(restarted.prepare(project, taskId, undefined, 'in-place'));
});

test('in-place rejects changed project registration and replaced repository identity', async t => {
  const { workspace, project, source } = await fixture(t);
  const taskId = randomUUID();
  await workspace.prepare(project, taskId, undefined, 'in-place');
  await assert.rejects(workspace.resume({ ...project, id: 'other' }, taskId), /conflict/);
  await assert.rejects(workspace.diff(taskId, { ...project, id: 'other' }), /conflict/);
  await assert.rejects(workspace.identity({ ...project, id: 'other' }, taskId), /conflict/);
  await rename(source, source + '-old');
  await mkdir(source);
  await exec('git', ['init'], { cwd: source });
  await assert.rejects(workspace.resume(project, taskId), /conflict/);
  await assert.rejects(workspace.diff(taskId), /conflict/);
  await assert.rejects(workspace.identity(project, taskId), /conflict/);
});

test('legacy workspace without metadata continues as worktree', async t => {
  const { workspace, project, root } = await fixture(t);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  await rm(join(root, 'data', 'workspace-metadata', taskId));
  assert.equal(await workspace.resume(project, taskId), cwd);
});

test('workspace metadata rejects oversized and symlink records', async t => {
  const { workspace, project, root } = await fixture(t);
  const taskId = randomUUID();
  await workspace.prepare(project, taskId, undefined, 'in-place');
  const record = join(root, 'data', 'workspace-metadata', taskId);
  await writeFile(record, ' '.repeat(17000));
  await assert.rejects(workspace.resume(project, taskId), /conflict/);
  await rm(record);
  await symlink(join(root, 'data', 'workspace-baselines', taskId), record);
  await assert.rejects(workspace.resume(project, taskId));
});
