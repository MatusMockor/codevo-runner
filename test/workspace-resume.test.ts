import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { GitProjectWorkspace } from '../src/infrastructure/projects/index.js';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-workspace-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'original\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const project = { id: 'sample', name: 'Sample', path: source };
  const data = join(root, 'data');
  const workspace = new GitProjectWorkspace(data);
  const taskId = randomUUID();
  const cwd = await workspace.prepare(project, taskId);
  return { root, source, project, data, workspace, taskId, cwd };
}

test('resuming after adapter restart preserves committed and uncommitted first-turn files', async t => {
  const { source, project, data, taskId, cwd } = await fixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'first turn\n');
  await exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'first turn']);
  await writeFile(join(cwd, 'pending.txt'), 'pending edit\n');
  const restarted = new GitProjectWorkspace(data);
  assert.equal(await restarted.resume(project, taskId), cwd);
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'first turn\n');
  assert.equal(await readFile(join(cwd, 'pending.txt'), 'utf8'), 'pending edit\n');
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'original\n');
  assert.match((await restarted.diff(taskId)).patch, /first turn/);
});

for (const replacement of ['missing', 'foreign', 'symlink'] as const) {
  test(`resume rejects ${replacement} worktree without recreating or modifying it`, async t => {
    const { root, project, workspace, taskId, cwd } = await fixture(t);
    await rm(cwd, { recursive: true, force: true });
    if (replacement === 'foreign') {
      await exec('git', ['init', cwd]);
      await writeFile(join(cwd, 'foreign.txt'), 'keep me');
    }
    if (replacement === 'symlink') await symlink(join(root, 'source'), cwd);
    await assert.rejects(workspace.resume(project, taskId));
    if (replacement === 'foreign') assert.equal(await readFile(join(cwd, 'foreign.txt'), 'utf8'), 'keep me');
  });
}

test('resume fails closed on missing baseline and pre-aborted operation', async t => {
  const { project, data, workspace, taskId } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.resume(project, taskId, controller.signal), { name: 'AbortError' });
  await rm(join(data, 'workspace-baselines', taskId));
  await assert.rejects(workspace.resume(project, taskId));
});
