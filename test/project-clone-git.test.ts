import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GitCloneAdapter } from '../src/infrastructure/projects/clone.js';

// Only the external SSH transport is stubbed; clone/checkout/filesystem are real Git.
test('Git clone checks out a selected branch, refuses collisions and cleans failed clones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codevo-clone-'));
  const oldPath = process.env.PATH;
  const oldFixture = process.env.CODEVO_TEST_REPOSITORY;
  try {
    const source = join(dir, 'source');
    const bin = join(dir, 'bin');
    const root = join(dir, 'Developer');
    await mkdir(source); await mkdir(bin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'file.txt'), 'main');
    git('add', '.'); git('commit', '-m', 'Initial');
    git('checkout', '-b', 'feature');
    await writeFile(join(source, 'file.txt'), 'feature');
    git('commit', '-am', 'Feature');
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec git-upload-pack "$CODEVO_TEST_REPOSITORY"\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.CODEVO_TEST_REPOSITORY = source;
    const adapter = new GitCloneAdapter(root);
    const input = { idempotencyKey: randomUUID(), url: 'git@example.invalid:owner/project.git', name: 'project', branch: 'feature' };
    const prepared = await adapter.clone(input, randomUUID(), new AbortController().signal);
    const project = prepared.project;
    assert.equal(project.path, await realpath(join(root, 'project')));
    assert.equal(await readFile(join(project.path, 'file.txt'), 'utf8'), 'feature');
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: project.path, encoding: 'utf8' }).trim(), 'feature');
    await assert.rejects(adapter.clone(input, randomUUID(), new AbortController().signal), /conflict/);
    assert.equal(await readFile(join(project.path, 'file.txt'), 'utf8'), 'feature');
    await assert.rejects(adapter.clone({ ...input, name: 'missing', branch: 'absent' }, randomUUID(), new AbortController().signal), /Git clone failed/);
    assert.deepEqual(await readdir(root), ['project']);
    await assert.rejects(adapter.clone({ ...input, name: '../escape' }, randomUUID(), new AbortController().signal), /invalid_input/);
    await assert.rejects(adapter.clone({ ...input, name: 'unsafe', url: 'file:///tmp/repo' }, randomUUID(), new AbortController().signal), /invalid_input/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.clone({ ...input, name: 'cancelled' }, randomUUID(), controller.signal));
    assert.deepEqual(await readdir(root), ['project']);
    const rollbackClone = await adapter.clone({ ...input, name: 'rollback' }, randomUUID(), new AbortController().signal);
    await rename(root, `${root}-owned`);
    await mkdir(root);
    await mkdir(join(root, 'rollback'));
    await writeFile(join(root, 'rollback', 'unrelated.txt'), 'untouched');
    await rollbackClone.rollback();
    assert.equal(await readFile(join(root, 'rollback', 'unrelated.txt'), 'utf8'), 'untouched');
    await rm(root, { recursive: true });
    await rename(`${root}-owned`, root);
    await rename(join(root, 'rollback'), join(root, 'rollback-owned'));
    await mkdir(join(root, 'rollback'));
    await writeFile(join(root, 'rollback', 'unrelated.txt'), 'untouched');
    await rollbackClone.rollback();
    assert.equal(await readFile(join(root, 'rollback', 'unrelated.txt'), 'utf8'), 'untouched');
    await rm(join(root, 'rollback'), { recursive: true });
    await rename(join(root, 'rollback-owned'), join(root, 'rollback'));
    await rollbackClone.rollback();
    await rollbackClone.rollback();
    assert.deepEqual(await readdir(root), ['project']);
    // Exercise cancellation while a real Git child awaits its external transport.
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho started > "$CODEVO_TEST_REPOSITORY/transport-started"\nsleep 30\n');
    const activeController = new AbortController();
    const activeClone = adapter.clone({ ...input, name: 'active' }, randomUUID(), activeController.signal);
    const failedClone = assert.rejects(activeClone, /Git clone cancelled/);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(join(source, 'transport-started'), 'utf8').catch(() => '') === 'started\n') break;
      await delay(20);
    }
    assert.equal(await readFile(join(source, 'transport-started'), 'utf8'), 'started\n');
    activeController.abort();
    await failedClone;
    assert.deepEqual(await readdir(root), ['project']);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldFixture === undefined) delete process.env.CODEVO_TEST_REPOSITORY; else process.env.CODEVO_TEST_REPOSITORY = oldFixture;
    await rm(dir, { recursive: true, force: true });
  }
});
