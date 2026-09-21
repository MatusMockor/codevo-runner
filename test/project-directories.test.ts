import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectDirectoriesAdapter } from '../src/infrastructure/projects/project-directories.js';
import { retainCloneDirectory } from '../src/infrastructure/projects/clone-directory.js';
import { parseCloneInput } from '../src/domain/project-clone.js';
import { randomUUID } from 'node:crypto';

test('directory browser bounds results, confines destinations, excludes symlinks and supports cancellation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'directories-'));
  try {
    const root = await realpath(temp);
    const projects = join(root, 'projects');
    const outside = join(root, 'outside');
    await mkdir(projects); await mkdir(outside); await mkdir(join(projects, 'nested'));
    await symlink(outside, join(projects, 'escape'));
    const adapter = new ProjectDirectoriesAdapter(projects);
    const signal = new AbortController().signal;
    const result = await adapter.list({}, signal);
    assert.deepEqual(result, { path: projects, parentPath: null, entries: [{ name: 'nested', path: join(projects, 'nested') }], truncated: false });
    assert.equal((await adapter.list({ path: join(projects, 'nested') }, signal)).parentPath, projects);
    for (const path of [outside, join(projects, 'escape'), projects + '/../outside', 'relative']) {
      await assert.rejects(adapter.list({ path }, signal), /invalid_input/);
    }
    await assert.rejects(adapter.list({ path: projects, extra: true }, signal), /invalid_input/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.list({}, controller.signal));
    await Promise.all(Array.from({ length: 260 }, (_, i) => mkdir(join(projects, `dir${i}`))));
    const bounded = await adapter.list({}, signal);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.entries.length, 256);
    const retained = await retainCloneDirectory(projects, join(projects, 'nested'));
    try {
      await rename(join(projects, 'nested'), join(projects, 'original'));
      await mkdir(join(projects, 'nested'));
      assert.equal(await retained.owned(), false);
    } finally { await retained.close(); }
    const rootLease = await retainCloneDirectory(projects);
    try {
      await rename(projects, join(root, 'owned-projects'));
      await symlink(outside, projects);
      assert.equal(await rootLease.owned(), false);
      await assert.rejects(adapter.list({}, signal), /storage_unavailable/);
    } finally { await rootLease.close(); }

  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('clone parentPath is strict and retained by the durable clone input', () => {
  const input = { idempotencyKey: randomUUID(), url: 'https://github.com/owner/repo.git', name: 'repo', parentPath: '/srv/projects/team' };
  assert.deepEqual(parseCloneInput(input), input);
  for (const parentPath of [null, 1, '/srv/../etc', 'relative', '/srv/\n', '/' + 'x'.repeat(4096), '/' + 'é'.repeat(2048), '/srv/\u0085']) {
    assert.throws(() => parseCloneInput({ ...input, parentPath }), /invalid_input/);
  }
});
