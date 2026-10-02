import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitRepositoryAdapter } from '../src/infrastructure/projects/git-sync.js';
import { gitSyncFixture, waitFor } from './git-sync-fixture.js';

const exec = promisify(execFile);
const key = () => ({ idempotencyKey: randomUUID() });
const author = { name: 'Server', email: 'server@example.invalid' };
const exists = (path: string) => access(path).then(() => true, () => false);
const gone = (pid: number) => waitFor(async () => {
  try { process.kill(pid, 0); return undefined; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : undefined; }
}, `process ${pid} survived`, 8_000);
const workdirOf = async (path: string) => {
  const info = await stat(path);
  return { cwd: await realpath(path), identity: { dev: info.dev, ino: info.ino } };
};

test('the operation registry evicts completed work, refuses when full, expires and closes truthfully', async t => {
  let clock = Date.now();
  const f = await gitSyncFixture(t, { gitSync: { service: { retainedOperations: 2, retentionMs: 1_000, now: () => clock } } });
  await f.mode('block');
  const first = await f.sync.fetch('project', key());
  const second = await f.sync.fetch('project', key());
  await waitFor(() => exists(join(f.ssh, 'blocked')).then(found => found || undefined), 'fetch transport did not start');
  await assert.rejects(f.sync.fetch('project', key()), /busy/);
  await writeFile(join(f.ssh, 'release'), '');
  assert.equal((await f.operation(first.id)).status, 'succeeded');
  assert.equal((await f.operation(second.id)).status, 'succeeded');
  const third = await f.operation((await f.sync.fetch('project', key())).id);
  assert.equal(third.status, 'succeeded');
  await assert.rejects(f.sync.operation(first.id), /not_found/);
  assert.equal((await f.sync.operation(second.id)).id, second.id);
  clock += 1_000;
  await assert.rejects(f.sync.operation(second.id), /not_found/);
  await assert.rejects(f.sync.operation(third.id), /not_found/);

  await rm(join(f.ssh, 'release'));
  await rm(join(f.ssh, 'blocked'));
  const update = await f.sync.update('project', key());
  await waitFor(() => exists(join(f.ssh, 'blocked')).then(found => found || undefined), 'update transport did not start');
  await f.sync.close();
  assert.deepEqual(await f.sync.operation(update.id), { id: update.id, kind: 'update', status: 'failed', error: 'busy', result: null });
  await assert.rejects(f.sync.fetch('project', key()), /busy/);
  await assert.rejects(f.sync.threadStatus(randomUUID()), /busy/);
  assert.equal(await exists(join(f.source, '.git', 'index.lock')), false);
});

test('an untracked file in the way of the fast-forward is reported as dirty', async t => {
  const f = await gitSyncFixture(t);
  await writeFile(join(f.peer, 'added.txt'), 'upstream\n');
  await f.run(f.peer, 'add', 'added.txt');
  await f.run(f.peer, 'commit', '-m', 'Added upstream');
  await f.run(f.peer, 'push', '--quiet', 'origin', 'main');
  await writeFile(join(f.source, 'added.txt'), 'local untracked\n');
  const update = await f.operation((await f.sync.update('project', key())).id);
  assert.equal(update.error, 'git_dirty');
  assert.equal(await readFile(join(f.source, 'added.txt'), 'utf8'), 'local untracked\n');
  assert.equal(await exists(join(f.source, '.git', 'index.lock')), false);
});

test('push and update deadlines fail as git_timeout and leave no transport process', async t => {
  const f = await gitSyncFixture(t, { gitAuthor: author, gitSync: { timeouts: { pushMs: 1_500 }, service: { updateMs: 1_500 } } });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project' });
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  await f.mode('sleep');
  const push = await f.operation((await f.sync.push(task.id, { ...key(), target: 'thread-branch' })).id);
  assert.equal(push.error, 'git_timeout');
  await gone(Number((await readFile(join(f.ssh, 'pid'), 'utf8')).trim()));
  await rm(join(f.ssh, 'pid'));
  const update = await f.operation((await f.sync.update('project', key())).id);
  assert.equal(update.error, 'git_timeout');
  await gone(Number((await readFile(join(f.ssh, 'pid'), 'utf8')).trim()));
  assert.equal(await f.remoteSha(`refs/heads/codevo/${task.id.replaceAll('-', '').slice(0, 8)}`), null);
});

test('a turn that cannot obtain its workspace lease fails as busy without launching the provider', async t => {
  const f = await gitSyncFixture(t, { gitAuthor: author, gitSync: { coordination: { leaseWaitMs: 800 } } });
  f.provider(async request => {
    await writeFile(join(request.cwd, 'file.txt'), 'turn\n');
    return { exitCode: 0, sessionId: '0194d46b-b92e-7000-8000-000000000001' };
  });
  const task = await f.create();
  await f.execution.start(task.id, { projectId: 'project', base: { kind: 'origin-branch', branch: 'main' } });
  assert.equal((await f.settled(task.id)).status, 'succeeded');
  await f.sync.commit(task.id, { message: 'Turn' });
  await f.mode('block');
  const push = await f.sync.push(task.id, { ...key(), target: 'thread-branch' });
  await waitFor(() => exists(join(f.ssh, 'blocked')).then(found => found || undefined), 'push transport did not start');
  const calls = f.calls();
  const next = await f.execution.continue(task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Again' }] });
  const failed = await f.settled(next.task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(await f.failure(failed), 'busy');
  assert.equal(f.calls(), calls);
  await writeFile(join(f.ssh, 'release'), '');
  assert.equal((await f.operation(push.id)).status, 'succeeded');
});

test('killing a blocked commit or fast-forward leaves no index lock and no moved HEAD', async t => {
  const f = await gitSyncFixture(t);
  const adapter = new GitRepositoryAdapter({ localMs: 1_500 });
  const workdir = await workdirOf(f.source);
  await f.run(f.source, 'config', 'filter.slow.clean', 'sleep 30');
  await f.run(f.source, 'config', 'filter.slow.smudge', 'cat');
  await writeFile(join(f.source, '.git', 'info', 'attributes'), 'file.txt filter=slow\n');
  await writeFile(join(f.source, 'file.txt'), 'blocked commit\n');
  const before = (await exec('git', ['rev-parse', 'HEAD'], { cwd: f.source })).stdout.trim();
  await assert.rejects(adapter.commit(workdir, 'Blocked', author, []), /git_timeout/);
  assert.equal(await exists(join(f.source, '.git', 'index.lock')), false);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: f.source })).stdout.trim(), before);

  await f.run(f.source, 'checkout', '--quiet', '--', 'file.txt');
  await f.run(f.source, 'config', 'filter.slow.clean', 'cat');
  await writeFile(join(f.peer, 'file.txt'), 'upstream change\n');
  await f.run(f.peer, 'commit', '-am', 'Upstream change');
  await f.run(f.peer, 'push', '--quiet', 'origin', 'main');
  assert.equal((await f.operation((await f.sync.fetch('project', key())).id)).status, 'succeeded');
  await f.run(f.source, 'config', 'filter.slow.smudge', 'sleep 30');
  await assert.rejects(adapter.fastForward(workdir), /git_timeout/);
  assert.equal(await exists(join(f.source, '.git', 'index.lock')), false);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: f.source })).stdout.trim(), before);
});
