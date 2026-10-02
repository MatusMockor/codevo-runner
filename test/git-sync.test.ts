import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gate, gitSyncFixture, waitFor } from './git-sync-fixture.js';
import { GitRepositoryAdapter } from '../src/infrastructure/projects/git-sync.js';

const exec = promisify(execFile);
const key = () => ({ idempotencyKey: randomUUID() });
const id8 = (taskId: string) => `codevo/${taskId.replaceAll('-', '').slice(0, 8)}`;
const head = async (cwd: string) => (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

test('a worktree thread starts from freshly fetched origin/<base>, commits, publishes and never forces the base', async t => {
  const f = await gitSyncFixture(t);
  await f.run(f.peer, 'checkout', '--quiet', 'feature');
  await writeFile(join(f.peer, 'file.txt'), 'landed on feature\n');
  await f.run(f.peer, 'commit', '-am', 'Landed after the checkout was cloned');
  const landed = await head(f.peer);
  await f.run(f.peer, 'push', '--quiet', 'origin', 'feature');
  let observed: { content: string; branch: string } | undefined;
  f.provider(async request => {
    observed = {
      content: await readFile(join(request.cwd, 'file.txt'), 'utf8'),
      branch: (await exec('git', ['branch', '--show-current'], { cwd: request.cwd })).stdout.trim(),
    };
    await writeFile(join(request.cwd, 'file.txt'), 'agent edit\n');
    return { exitCode: 0 };
  });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'feature' } });
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  assert.deepEqual(observed, { content: 'landed on feature\n', branch: id8(task.id) });

  const before = await f.sync.threadStatus(task.id);
  assert.equal(before.mode, 'worktree');
  assert.equal(before.branch, id8(task.id));
  assert.equal(before.base?.branch, 'feature');
  assert.equal(before.base?.sha, landed);
  assert.equal(before.base?.ahead, 0);
  assert.equal(before.published, null);
  assert.deepEqual(before.dirty, { tracked: 1, untracked: 0, truncated: false });
  assert.equal(before.active, false);

  await f.run(f.source, 'config', 'user.name', 'Server');
  await f.run(f.source, 'config', 'user.email', 'server@example.invalid');
  const committed = await f.sync.commit(task.id, { message: 'Agent work\n\nDetails.' });
  assert.equal(committed.status.headSha, committed.commitSha);
  assert.equal(committed.status.base?.ahead, 1);
  assert.deepEqual(committed.status.dirty, { tracked: 0, untracked: 0, truncated: false });
  await assert.rejects(f.sync.commit(task.id, { message: 'Nothing' }), /git_nothing_to_commit/);

  const worktree = join(f.root, 'data', 'workspaces', task.id);
  await exec('git', ['tag', 'v1'], { cwd: worktree });
  const pushKey = key();
  const pushed = await f.sync.push(task.id, { ...pushKey, target: 'thread-branch' });
  assert.equal(pushed.status, 'running');
  assert.equal((await f.sync.push(task.id, { ...pushKey, target: 'thread-branch' })).id, pushed.id);
  await assert.rejects(f.sync.push(task.id, { ...pushKey, target: 'base-branch' }), /conflict/);
  const published = await f.operation(pushed.id);
  assert.deepEqual(published.result, { kind: 'push', remoteRef: `refs/heads/${id8(task.id)}`, pushedSha: committed.commitSha, created: true });
  assert.equal(await f.remoteSha(`refs/heads/${id8(task.id)}`), committed.commitSha);
  assert.equal(await f.remoteSha('refs/tags/v1'), null);
  const again = await f.operation((await f.sync.push(task.id, { ...key(), target: 'thread-branch' })).id);
  assert.equal(again.status, 'succeeded');
  assert.equal(again.result?.kind === 'push' && again.result.created, false);
  assert.deepEqual((await f.sync.threadStatus(task.id)).published, { ref: `origin/${id8(task.id)}`, ahead: 0, behind: 0 });

  const toBase = await f.operation((await f.sync.push(task.id, { ...key(), target: 'base-branch' })).id);
  assert.equal(toBase.status, 'succeeded');
  assert.equal(await f.remoteSha('refs/heads/feature'), committed.commitSha);

  await f.run(f.peer, 'pull', '--quiet', '--ff-only', 'origin', 'feature');
  await writeFile(join(f.peer, 'file.txt'), 'peer moved feature\n');
  await f.run(f.peer, 'commit', '-am', 'Peer moved feature');
  const peerTip = await head(f.peer);
  await f.run(f.peer, 'push', '--quiet', 'origin', 'feature');
  await writeFile(join(worktree, 'file.txt'), 'second agent edit\n');
  await f.sync.commit(task.id, { message: 'Second' });
  const rejected = await f.operation((await f.sync.push(task.id, { ...key(), target: 'base-branch' })).id);
  assert.deepEqual(rejected, { ...rejected, status: 'failed', error: 'git_rejected_non_fast_forward', result: null });
  assert.equal(await f.remoteSha('refs/heads/feature'), peerTip);
});

test('a start-time fetch failure fails the turn truthfully before any provider launch', async t => {
  const f = await gitSyncFixture(t);
  await f.mode('fail');
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'feature' } });
  assert.equal((await f.settled(task.id)).status, 'failed');
  assert.equal(await f.failure(task), 'git_remote_unavailable');
  assert.equal(f.calls(), 0);
  await assert.rejects(access(join(f.root, 'data', 'workspaces', task.id)), { code: 'ENOENT' });

  await f.mode('auth');
  const auth = await f.operation((await f.sync.fetch('project', key())).id);
  assert.equal(auth.error, 'git_auth_failed');

  await f.mode('');
  const missing = await f.create();
  await f.execution.start(missing.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'absent' } });
  assert.equal((await f.settled(missing.id)).status, 'failed');
  assert.equal(await f.failure(missing), 'git_branch_not_found');
  assert.equal(f.calls(), 0);

  const inPlace = await f.create('in-place');
  await assert.rejects(f.execution.start(inPlace.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'feature' } }), /invalid_input/);
  const retried = await f.create();
  await f.execution.start(retried.id, { projectId: 'project', base: { kind: 'checkout-head' } });
  await assert.rejects(f.execution.start(retried.id, { projectId: 'project' }), /conflict/);
  await f.execution.start(retried.id, { projectId: 'project', base: { kind: 'checkout-head' } });
  assert.equal((await f.settled(retried.id)).status, 'succeeded');
});

test('legacy detached threads publish codevo/<id8> and cannot target a base', async t => {
  const f = await gitSyncFixture(t, { gitAuthor: { name: 'Configured', email: 'configured@example.invalid' } });
  f.provider(async request => { await writeFile(join(request.cwd, 'new.txt'), 'new\n'); return { exitCode: 0 }; });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project' });
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  const status = await f.sync.threadStatus(task.id);
  assert.deepEqual({ branch: status.branch, base: status.base, published: status.published, dirty: status.dirty },
    { branch: null, base: null, published: null, dirty: { tracked: 0, untracked: 1, truncated: false } });
  const worktree = join(f.root, 'data', 'workspaces', task.id);
  await mkdir(join(worktree, '.codevo-instructions', 'global'), { recursive: true });
  await mkdir(join(worktree, '.claude', 'rules', 'codevo-global'), { recursive: true });
  await writeFile(join(worktree, '.codevo-instructions', 'global', 'CLAUDE.md'), 'private global rules\n');
  await writeFile(join(worktree, '.claude', 'rules', 'codevo-global', 'style.md'), 'private rule\n');
  const committed = await f.sync.commit(task.id, { message: 'Legacy' });
  const author = (await exec('git', ['log', '-1', '--format=%an <%ae>'], { cwd: worktree })).stdout.trim();
  assert.equal(author, 'Configured <configured@example.invalid>');
  assert.deepEqual((await exec('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: worktree })).stdout.trim().split('\n'), ['new.txt']);
  assert.deepEqual((await f.sync.threadStatus(task.id)).dirty, { tracked: 0, untracked: 0, truncated: false });

  await writeFile(join(worktree, 'CLAUDE.local.md'), 'synchronized project rule\n');
  await writeFile(join(worktree, 'kept.txt'), 'kept\n');
  const workdir = { cwd: await realpath(worktree), identity: await stat(worktree) };
  const adapter = new GitRepositoryAdapter();
  await adapter.commit({ cwd: workdir.cwd, identity: { dev: workdir.identity.dev, ino: workdir.identity.ino } },
    'Direct', { name: 'Configured', email: 'configured@example.invalid' }, ['CLAUDE.local.md']);
  assert.deepEqual((await exec('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: worktree })).stdout.trim().split('\n'), ['kept.txt']);
  await exec('git', ['reset', '--quiet', '--soft', 'HEAD~1'], { cwd: worktree });
  await exec('git', ['reset', '--quiet'], { cwd: worktree });
  await rm(join(worktree, 'CLAUDE.local.md'));
  await rm(join(worktree, 'kept.txt'));
  await assert.rejects(f.sync.push(task.id, { ...key(), target: 'base-branch' }), /conflict/);
  const pushed = await f.operation((await f.sync.push(task.id, { ...key(), target: 'thread-branch' })).id);
  assert.equal(pushed.status, 'succeeded');
  assert.equal(await f.remoteSha(`refs/heads/${id8(task.id)}`), committed.commitSha);
  assert.deepEqual((await f.sync.threadStatus(task.id)).published, { ref: `origin/${id8(task.id)}`, ahead: 0, behind: 0 });
});

test('commit and push refuse while the conversation runs and identity must be configured', async t => {
  const f = await gitSyncFixture(t);
  const running = gate();
  const release = gate();
  f.provider(async request => {
    await writeFile(join(request.cwd, 'file.txt'), 'in progress\n');
    running.open();
    await release.opened;
    return { exitCode: 0 };
  });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project' });
  await running.opened;
  assert.equal((await f.sync.threadStatus(task.id)).active, true);
  await assert.rejects(f.sync.commit(task.id, { message: 'Too early' }), /busy/);
  await assert.rejects(f.sync.push(task.id, { ...key(), target: 'thread-branch' }), /busy/);
  release.open();
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  await assert.rejects(f.sync.commit(task.id, { message: 'No identity' }), /git_identity_missing/);
  await f.run(f.source, 'config', 'user.name', 'Repo');
  await f.run(f.source, 'config', 'user.email', 'repo@example.invalid');
  assert.match((await f.sync.commit(task.id, { message: 'With identity' })).commitSha, /^[0-9a-f]{40}$/);
  await assert.rejects(f.sync.commit(task.id, { message: 'a\u0000b' }), /invalid_input/);
});

test('Update from origin fast-forwards a clean checkout and refuses every unsafe state', async t => {
  const f = await gitSyncFixture(t);
  await writeFile(join(f.peer, 'file.txt'), 'main moved\n');
  await f.run(f.peer, 'commit', '-am', 'Main moved');
  const moved = await head(f.peer);
  await f.run(f.peer, 'push', '--quiet', 'origin', 'main');

  await writeFile(join(f.source, 'file.txt'), 'dirty\n');
  await assert.rejects(f.sync.update('project', key()), /git_dirty/);
  await f.run(f.source, 'checkout', '--quiet', '--', 'file.txt');
  await f.run(f.source, 'checkout', '--quiet', '--detach');
  await assert.rejects(f.sync.update('project', key()), /git_detached_head/);
  await f.run(f.source, 'checkout', '--quiet', 'main');
  await f.run(f.source, 'branch', '--unset-upstream');
  await assert.rejects(f.sync.update('project', key()), /git_no_upstream/);
  await f.run(f.source, 'branch', '--quiet', '-u', 'origin/main');
  await writeFile(join(f.source, '.git', 'MERGE_HEAD'), `${moved}\n`);
  await assert.rejects(f.sync.update('project', key()), /git_operation_in_progress/);
  await rm(join(f.source, '.git', 'MERGE_HEAD'));

  const running = gate();
  const release = gate();
  f.provider(async () => { running.open(); await release.opened; return { exitCode: 0 }; });
  const inPlace = await f.create('in-place');
  await f.execution.start(inPlace.id, { projectId: 'project' });
  await running.opened;
  assert.equal((await f.sync.projectStatus('project')).inPlaceTaskActive, true);
  await assert.rejects(f.sync.update('project', key()), /busy/);
  release.open();
  await f.settled(inPlace.id);

  const updateKey = key();
  const update = await f.sync.update('project', updateKey);
  assert.equal((await f.sync.update('project', updateKey)).id, update.id);
  await assert.rejects(f.sync.fetch('project', updateKey), /conflict/);
  const updated = await f.operation(update.id);
  assert.deepEqual(updated.result, { kind: 'update', headSha: moved, fastForwarded: 1 });
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'main moved\n');
  const status = await f.sync.projectStatus('project');
  assert.deepEqual({ branch: status.branch, upstream: status.upstream, operation: status.operation },
    { branch: 'main', upstream: { ref: 'origin/main', ahead: 0, behind: 0 }, operation: 'none' });
  assert.ok(status.fetchedAt);

  await writeFile(join(f.peer, 'file.txt'), 'main moved again\n');
  await f.run(f.peer, 'commit', '-am', 'Again');
  await f.run(f.peer, 'push', '--quiet', 'origin', 'main');
  await writeFile(join(f.source, 'local.txt'), 'local\n');
  await f.run(f.source, 'add', 'local.txt');
  await f.run(f.source, 'commit', '-m', 'Local only');
  const diverged = await f.sync.update('project', key());
  assert.deepEqual(await f.operation(diverged.id), { id: diverged.id, kind: 'update', status: 'failed', error: 'git_diverged', result: null });
});

test('branch listing is bounded, fetches coalesce and credentialed push URLs are refused', async t => {
  const f = await gitSyncFixture(t);
  const listed = await f.sync.branches('project');
  assert.deepEqual({ defaultBranch: listed.defaultBranch, checkoutBranch: listed.checkoutBranch, fetchedAt: listed.fetchedAt, truncated: listed.truncated },
    { defaultBranch: 'main', checkoutBranch: 'main', fetchedAt: null, truncated: false });
  assert.deepEqual(listed.branches.map(branch => branch.name).sort(), ['feature', 'main']);
  const first = await f.operation((await f.sync.fetch('project', key())).id);
  assert.equal(first.status, 'succeeded');
  const calls = await f.sshCalls();
  const second = await f.operation((await f.sync.fetch('project', key())).id);
  assert.deepEqual(second.result, first.result);
  assert.equal(await f.sshCalls(), calls);
  assert.equal((await f.sync.branches('project')).fetchedAt, first.result?.kind === 'fetch' ? first.result.fetchedAt : undefined);

  await f.run(f.source, 'config', 'remote.origin.pushurl', 'https://user:token@example.invalid/owner/project.git');
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project' });
  await f.settled(task.id);
  const refused = await f.operation((await f.sync.push(task.id, { ...key(), target: 'thread-branch' })).id);
  assert.equal(refused.error, 'git_remote_unsupported');
  await assert.rejects(f.sync.operation('not-a-uuid'), /invalid_input/);
  await assert.rejects(f.sync.operation(randomUUID()), /not_found/);
});

test('a fetch deadline kills the whole Git process group', async t => {
  const f = await gitSyncFixture(t, { gitSync: { timeouts: { fetchMs: 1500 } } });
  await f.mode('sleep');
  const started = Date.now();
  const timedOut = await f.operation((await f.sync.fetch('project', key())).id);
  assert.equal(timedOut.error, 'git_timeout');
  assert.ok(Date.now() - started < 10_000);
  const pid = Number((await readFile(join(f.ssh, 'pid'), 'utf8')).trim());
  await waitFor(async () => {
    try { process.kill(pid, 0); return undefined; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : undefined; }
  }, 'transport process survived the deadline', 5_000);
  await f.mode('');
  await f.run(f.source, 'remote', 'remove', 'origin');
  const noRemote = await f.operation((await f.sync.fetch('project', key())).id);
  assert.equal(noRemote.error, 'git_no_remote');
});

test('a follow-up turn waits for the workspace lease held by a push', async t => {
  const f = await gitSyncFixture(t);
  f.provider(async request => { await writeFile(join(request.cwd, 'file.txt'), 'turn\n'); return { exitCode: 0, sessionId: '0194d46b-b92e-7000-8000-000000000001' }; });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'main' } });
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  await f.run(f.source, 'config', 'user.name', 'Server');
  await f.run(f.source, 'config', 'user.email', 'server@example.invalid');
  await f.sync.commit(task.id, { message: 'Turn' });
  await f.mode('block');
  const push = await f.sync.push(task.id, { ...key(), target: 'thread-branch' });
  await waitFor(() => access(join(f.ssh, 'blocked')).then(() => true, () => undefined), 'push transport did not start');
  const calls = f.calls();
  const next = await f.execution.continue(task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Again' }] });
  await delay(600);
  assert.equal(f.calls(), calls);
  assert.equal((await f.services.tasks.get(next.task.id)).status, 'running');
  await f.mode('');
  await writeFile(join(f.ssh, 'release'), '');
  assert.equal((await f.operation(push.id)).status, 'succeeded');
  assert.equal((await f.settled(next.task.id)).status, 'succeeded');
  assert.equal(f.calls(), calls + 1);
});
