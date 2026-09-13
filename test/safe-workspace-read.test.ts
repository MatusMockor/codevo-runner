import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerError } from '../src/domain/contracts.js';
import { readSafeWorkspaceFile } from '../src/infrastructure/projects/safe-workspace-read.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'safe-workspace-read-')));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const { dev, ino } = await stat(cwd);
  return { root, cwd, expected: { dev, ino } };
}
const conflict = (error: unknown) => error instanceof RunnerError && error.code === 'conflict';

test('descriptor reader handles nested Unicode, deleted and bounded file content', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, 'nested'));
    await writeFile(join(f.cwd, 'nested', '雪.ts'), 'const greeting = "čau 🌍";\n');
    assert.deepEqual(await readSafeWorkspaceFile({ ...f, path: 'nested/雪.ts' }), {
      text: 'const greeting = "čau 🌍";\n', truncated: false, unavailableReason: null,
    });
    for (const path of ['missing.txt', 'absent/child.txt']) {
      assert.deepEqual(await readSafeWorkspaceFile({ ...f, path }), { text: '', truncated: false, unavailableReason: null });
    }
    await writeFile(join(f.cwd, 'limit'), 'a'.repeat(65536));
    assert.equal((await readSafeWorkspaceFile({ ...f, path: 'limit' })).text.length, 65536);
    await writeFile(join(f.cwd, 'large'), 'a'.repeat(65537));
    assert.deepEqual(await readSafeWorkspaceFile({ ...f, path: 'large' }), { text: '', truncated: true, unavailableReason: 'large' });
    for (const bytes of [Buffer.from([0, 65]), Buffer.from([0xff, 0xfe])]) {
      await writeFile(join(f.cwd, 'binary'), bytes);
      assert.deepEqual(await readSafeWorkspaceFile({ ...f, path: 'binary' }), { text: '', truncated: false, unavailableReason: 'binary' });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('descriptor reader rejects symlink roots, parents, leaves, hardlinks and special files', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'outside authority');
    await symlink(outside, join(f.cwd, 'parent'));
    await symlink(join(outside, 'secret'), join(f.cwd, 'leaf'));
    await symlink(join(outside, 'missing'), join(f.cwd, 'broken'));
    await link(join(outside, 'secret'), join(f.cwd, 'hardlink'));
    await mkdir(join(f.cwd, 'directory'));
    execFileSync('mkfifo', [join(f.cwd, 'fifo')]);
    for (const path of ['parent/secret', 'leaf', 'broken', 'hardlink', 'directory', 'fifo']) {
      await assert.rejects(readSafeWorkspaceFile({ ...f, path }), conflict);
    }
    const alias = join(f.root, 'alias');
    await symlink(f.cwd, alias);
    await assert.rejects(readSafeWorkspaceFile({ ...f, cwd: alias, path: 'missing' }), conflict);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('descriptor reader fails closed after captured root replacement', async () => {
  const f = await fixture();
  try {
    await rename(f.cwd, join(f.root, 'original'));
    await mkdir(f.cwd);
    await writeFile(join(f.cwd, 'secret'), 'replacement data');
    await assert.rejects(readSafeWorkspaceFile({ ...f, path: 'secret' }), conflict);
    await rm(f.cwd, { recursive: true });
    await assert.rejects(readSafeWorkspaceFile({ ...f, path: 'secret' }), conflict);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('descriptor reader rejects invalid paths before launching its helper', async () => {
  const f = await fixture();
  try {
    for (const path of ['../secret', '/secret', 'nested/../secret', 'a\0b', '']) {
      await assert.rejects(readSafeWorkspaceFile({ ...f, path }), RunnerError);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing Python runtime returns storage_unavailable, never empty content', async () => {
  const f = await fixture();
  try {
    const moduleUrl = new URL('../src/infrastructure/projects/safe-workspace-read.js', import.meta.url).href;
    const script = `
      import { readSafeWorkspaceFile } from ${JSON.stringify(moduleUrl)};
      try {
        await readSafeWorkspaceFile(JSON.parse(process.argv[1]));
        process.exit(2);
      } catch (error) {
        if (error.code !== 'storage_unavailable' || error.message !== 'storage_unavailable') process.exit(3);
      }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...f, path: 'file' })], {
      env: { ...process.env, PATH: '/codevo-missing-python-runtime' }, timeout: 10_000,
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
