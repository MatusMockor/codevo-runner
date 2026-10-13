import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, rename, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from '../src/infrastructure/projects/index.js';
import { FolderProjectWorkspace } from '../src/infrastructure/projects/folder-workspace.js';
import { ProjectWorkspaceRouter } from '../src/infrastructure/projects/workspace-router.js';

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

type StoredIdentity = { dev: number; ino: number };
type StoredMetadata = { sourceIdentity: StoredIdentity; commonIdentity: StoredIdentity };
async function rewriteMetadata(root: string, taskId: string, change: (record: StoredMetadata) => StoredMetadata) {
  const path = join(root, 'data', 'workspace-metadata', taskId);
  await writeFile(path, JSON.stringify(change(JSON.parse(await readFile(path, 'utf8')) as StoredMetadata)));
}

test('workspace records persisted before a device renumbering resume with the live identity', async t => {
  const { workspace, project, source, root } = await fixture(t);
  const inPlace = randomUUID();
  const worktree = randomUUID();
  const checkout = await workspace.prepare(project, inPlace, undefined, 'in-place');
  const cwd = await workspace.prepare(project, worktree);
  const renumbered = (identity: StoredIdentity) => ({ dev: identity.dev + 1, ino: identity.ino });
  for (const taskId of [inPlace, worktree])
    await rewriteMetadata(root, taskId, record => ({ ...record, sourceIdentity: renumbered(record.sourceIdentity), commonIdentity: renumbered(record.commonIdentity) }));
  const restarted = new GitProjectWorkspace(join(root, 'data'));
  const live = await lstat(await realpath(source));
  assert.equal(await restarted.resume(project, inPlace), checkout);
  assert.deepEqual(await restarted.identity(project, inPlace), { dev: live.dev, ino: live.ino });
  assert.deepEqual(await restarted.thread(project, inPlace), { mode: 'in-place', workdir: { cwd: checkout, identity: { dev: live.dev, ino: live.ino } }, record: null });
  await writeFile(join(source, 'tracked.txt'), 'after reboot\n');
  assert.match((await restarted.diff(inPlace)).patch, /after reboot/);
  assert.equal(await restarted.resume(project, worktree), cwd);
  assert.equal((await restarted.thread(project, worktree)).mode, 'worktree');
});

for (const replaced of ['sourceIdentity', 'commonIdentity'] as const) {
  test(`workspace record with a different ${replaced} inode still conflicts`, async t => {
    const { workspace, project, root } = await fixture(t);
    const taskId = randomUUID();
    await workspace.prepare(project, taskId, undefined, 'in-place');
    await rewriteMetadata(root, taskId, record => ({ ...record, [replaced]: { dev: record[replaced].dev, ino: record[replaced].ino + 1 } }));
    await assert.rejects(workspace.resume(project, taskId), /conflict/);
    await assert.rejects(workspace.identity(project, taskId), /conflict/);
    await assert.rejects(workspace.thread(project, taskId), /conflict/);
    await assert.rejects(workspace.diff(taskId), /conflict/);
  });
}

async function folderFixture(t: {after(fn:()=>Promise<void>):void}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codevo-folder-workspace-')));
  const path = process.env.PATH;
  t.after(async () => {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  });
  const folder = join(root, 'folder'), data = join(root, 'data'), bin = join(root, 'bin'), launches = join(root, 'git-launches');
  for (const directory of [folder, bin]) await mkdir(directory);
  await writeFile(join(folder, 'notes.txt'), 'plain folder\n');
  const git = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> "${launches}"\nexec "${git}" "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${path ?? ''}`;
  const project = { id: 'folder', name: 'Folder', path: folder, kind: 'folder' as const };
  const router = () => new ProjectWorkspaceRouter(data, new GitProjectWorkspace(data), new FolderProjectWorkspace(data));
  const gitLaunches = async () => (await readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { root, folder, data, git, project, router, workspace: router(), gitLaunches };
}
const notRepository = { name: 'RunnerError', code: 'git_not_repository' };
const invalid = { name: 'RunnerError', code: 'invalid_input' };
const conflicting = { name: 'RunnerError', code: 'conflict' };

test('a folder project prepares in place only and records folder metadata instead of a Git baseline', async t => {
  const { workspace, project, folder, data, gitLaunches } = await folderFixture(t);
  const origin = { kind: 'origin-branch', branch: 'main' } as const;
  for (const isolation of ['worktree', undefined] as const) {
    assert.throws(() => workspace.validateStart(project, isolation), invalid);
    await assert.rejects(workspace.prepare(project, randomUUID(), undefined, isolation), invalid);
  }
  assert.throws(() => workspace.validateStart(project, 'in-place', origin), invalid);
  await assert.rejects(workspace.prepare(project, randomUUID(), undefined, 'in-place', origin), invalid);
  await assert.rejects(workspace.prepare(project, '../escape', undefined, 'in-place'), invalid);
  await assert.rejects(workspace.prepare(project, randomUUID(), AbortSignal.abort(), 'in-place'), { name: 'AbortError' });
  await assert.rejects(readdir(data), { code: 'ENOENT' });
  assert.equal(workspace.validateStart(project, 'in-place'), undefined);
  assert.equal(workspace.validateStart(project, 'in-place', { kind: 'checkout-head' }), undefined);
  for (const isolation of ['worktree', 'in-place', undefined] as const) assert.equal(workspace.validateStart({ ...project, kind: undefined }, isolation, origin), undefined);
  const taskId = randomUUID();
  assert.equal(await workspace.prepare(project, taskId, undefined, 'in-place'), folder);
  const live = await lstat(folder);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'workspace-metadata', taskId), 'utf8')),
    { version: 2, kind: 'folder', mode: 'in-place', projectId: 'folder', source: folder, sourceIdentity: { dev: live.dev, ino: live.ino } });
  assert.deepEqual(await readdir(data), ['workspace-metadata']);
  await assert.rejects(workspace.prepare(project, taskId, undefined, 'in-place'), { code: 'EEXIST' });
  assert.equal(await workspace.resume(project, taskId), folder);
  assert.deepEqual(await workspace.identity(project, taskId), { dev: live.dev, ino: live.ino });
  assert.deepEqual(await workspace.checkout(project), { cwd: folder, identity: { dev: live.dev, ino: live.ino } });
  assert.equal(await workspace.repositoryIdentity(project), null);
  assert.equal(await workspace.awaitGitLease(project, taskId, 'in-place'), undefined);
  await assert.rejects(workspace.thread(project, taskId), notRepository);
  await assert.rejects(workspace.diff(taskId, project), notRepository);
  await assert.rejects(workspace.diff(taskId), notRepository);
  await assert.rejects(workspace.files(project, taskId), notRepository);
  await assert.rejects(workspace.fileDiff(project, taskId, 'notes.txt'), notRepository);
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'plain folder\n');
  assert.deepEqual(await gitLaunches(), []);
});

test('a folder that later becomes a repository stays a folder and Git is never run in it', async t => {
  const { workspace, router, project, folder, git, gitLaunches } = await folderFixture(t);
  const taskId = randomUUID();
  await workspace.prepare(project, taskId, undefined, 'in-place');
  await exec(git, ['init', '-q', '-b', 'main', folder]);
  await exec(git, ['-C', folder, 'add', '.']);
  await exec(git, ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'agent commit']);
  const restarted = router();
  const later = randomUUID();
  assert.equal(await restarted.prepare(project, later, undefined, 'in-place'), folder);
  for (const id of [taskId, later]) {
    assert.equal(await restarted.resume(project, id), folder);
    await assert.rejects(restarted.thread(project, id), notRepository);
    await assert.rejects(restarted.diff(id, project), notRepository);
    await assert.rejects(restarted.files(project, id), notRepository);
  }
  assert.equal(await restarted.repositoryIdentity(project), null);
  assert.equal((await restarted.checkout(project)).cwd, folder);
  assert.deepEqual(await gitLaunches(), []);
  await assert.rejects(lstat(join(folder, '.git', 'refs', 'codevo')), { code: 'ENOENT' });
});

test('a task whose recorded kind differs from its project is refused in both directions', async t => {
  const { workspace, project, folder, root, git } = await folderFixture(t);
  const folderTask = randomUUID();
  await workspace.prepare(project, folderTask, undefined, 'in-place');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec(git, ['init', '-q', '-b', 'main', source]);
  await exec(git, ['-C', source, 'add', '.']);
  await exec(git, ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial']);
  const repository = { id: 'source', name: 'Source', path: source };
  const repositoryTask = randomUUID();
  await workspace.prepare(repository, repositoryTask, undefined, 'in-place');
  await exec(git, ['init', '-q', '-b', 'main', folder]);
  const mismatched = [[{ id: 'folder', name: 'Folder', path: folder }, folderTask], [{ ...repository, kind: 'folder' as const }, repositoryTask]] as const;
  for (const [presented, taskId] of mismatched) {
    await assert.rejects(workspace.resume(presented, taskId), conflicting);
    await assert.rejects(workspace.identity(presented, taskId), conflicting);
    await assert.rejects(workspace.thread(presented, taskId), conflicting);
    await assert.rejects(workspace.diff(taskId, presented), conflicting);
    await assert.rejects(workspace.files(presented, taskId), conflicting);
    await assert.rejects(workspace.fileDiff(presented, taskId, 'tracked.txt'), conflicting);
  }
  for (const id of ['../escape', 'not-a-task', '']) {
    await assert.rejects(workspace.resume(project, id), invalid);
    await assert.rejects(workspace.diff(id, project), invalid);
    await assert.rejects(workspace.thread(project, id), invalid);
  }
  await assert.rejects(workspace.resume(project, randomUUID()), conflicting);
  await assert.rejects(workspace.diff(randomUUID(), project), notRepository);
  await writeFile(join(source, 'tracked.txt'), 'edited\n');
  assert.match((await workspace.diff(repositoryTask, repository)).patch, /\+edited/);
  assert.match((await workspace.diff(repositoryTask)).patch, /\+edited/);
  assert.equal((await workspace.thread(repository, repositoryTask)).mode, 'in-place');
});

test('repository projects pass through the router unchanged, including a repository that lost its Git directory', async t => {
  const { workspace: direct, project, source, root } = await fixture(t);
  const data = join(root, 'data');
  const routed = new ProjectWorkspaceRouter(data, direct, new FolderProjectWorkspace(data));
  const worktree = randomUUID(), inPlace = randomUUID();
  const cwd = await routed.prepare(project, worktree);
  assert.equal(cwd, join(data, 'workspaces', worktree));
  assert.equal(await routed.prepare(project, inPlace, undefined, 'in-place'), await realpath(source));
  await writeFile(join(cwd, 'tracked.txt'), 'task edit\n');
  for (const taskId of [worktree, inPlace]) {
    assert.equal(await routed.resume(project, taskId), await direct.resume(project, taskId));
    assert.deepEqual(await routed.identity(project, taskId), await direct.identity(project, taskId));
    assert.deepEqual(await routed.thread(project, taskId), await direct.thread(project, taskId));
    assert.deepEqual(await routed.diff(taskId, project), await direct.diff(taskId, project));
    assert.deepEqual(await routed.files(project, taskId), await direct.files(project, taskId));
  }
  assert.deepEqual(await routed.fileDiff(project, worktree, 'tracked.txt'), await direct.fileDiff(project, worktree, 'tracked.txt'));
  assert.deepEqual(await routed.checkout(project), await direct.checkout(project));
  assert.equal(await routed.repositoryIdentity(project), null);
  await rm(join(root, 'data', 'workspace-metadata', worktree));
  assert.equal(await routed.resume(project, worktree), cwd);
  await rm(join(source, '.git'), { recursive: true });
  const failure = (attempt: Promise<unknown>) => attempt.then(() => 'resolved', (error: Error) => `${error.name}: ${error.message}`);
  for (const taskId of [worktree, inPlace]) {
    assert.equal(await failure(routed.resume(project, taskId)), await failure(direct.resume(project, taskId)));
    assert.notEqual(await failure(routed.resume(project, taskId)), 'resolved');
    assert.equal(await failure(routed.diff(taskId, project)), await failure(direct.diff(taskId, project)));
  }
  assert.equal(await failure(routed.checkout(project)), await failure(direct.checkout(project)));
  assert.notEqual(await failure(routed.checkout(project)), 'resolved');
  assert.equal(await failure(routed.prepare(project, randomUUID(), undefined, 'in-place')), await failure(direct.prepare(project, randomUUID(), undefined, 'in-place')));
});
