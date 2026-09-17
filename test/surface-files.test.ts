import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, lstat, symlink, readFile, rm, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfaceFiles } from '../src/infrastructure/projects/surface-files.js';
import { parseSurfaceInput, type SurfaceFile, type SurfaceTree } from '../src/domain/surface-files.js';
import { RunnerError } from '../src/domain/contracts.js';
const conflict = (error: unknown) => error instanceof RunnerError && error.code === 'conflict';
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'surface-files-'));
  const identity = await lstat(cwd);
  return { cwd, identity, revalidate: async () => {}, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const signal = () => AbortSignal.timeout(15000);
test('tree pagination, hidden git exclusion, read and atomic versioned save', async () => {
  const ws = await fixture();
  try {
    await mkdir(join(ws.cwd, '.git'));
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(ws.cwd, `f${String(index).padStart(3, '0')}`), 'before')));
    const page = await surfaceFiles(ws, 'tree', { path: '', offset: 0 }, signal()) as SurfaceTree;
    assert.equal(page.entries.length, 200); assert.equal(page.nextOffset, 200); assert.equal(page.truncated, false);
    const next = await surfaceFiles(ws, 'tree', { path: '', offset: 200 }, signal()) as SurfaceTree;
    assert.equal(next.entries.length, 5); assert.equal(next.nextOffset, null);
    await chmod(join(ws.cwd, 'f000'), 0o664);
    const file = await surfaceFiles(ws, 'read', { path: 'f000' }, signal()) as SurfaceFile;
    const saved = await surfaceFiles(ws, 'write', { path: 'f000', text: 'after ž', expectedVersion: file.version! }, signal()) as SurfaceFile;
    assert.equal((await lstat(join(ws.cwd, 'f000'))).mode & 0o777, 0o664);
    assert.equal(saved.text, 'after ž'); assert.notEqual(saved.version, file.version);
    assert.equal(await readFile(join(ws.cwd, 'f000'), 'utf8'), 'after ž');
    await assert.rejects(surfaceFiles(ws, 'write', { path: 'f000', text: 'lost', expectedVersion: file.version! }, signal()), conflict);
  } finally { await ws.cleanup(); }
});
test('concurrent writes cannot both consume the same version', async () => {
  const ws = await fixture();
  try {
    await writeFile(join(ws.cwd, 'file'), 'original');
    const file = await surfaceFiles(ws, 'read', { path: 'file' }, signal()) as SurfaceFile;
    const writes = await Promise.allSettled(['one', 'two'].map(text => surfaceFiles(ws, 'write', { path: 'file', text, expectedVersion: file.version! }, signal())));
    assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(writes.filter(item => item.status === 'rejected' && conflict(item.reason)).length, 1);
  } finally { await ws.cleanup(); }
});
test('symlink/hardlink/identity escapes fail closed, binary and large are explicit', async () => {
  const ws = await fixture(); const outside = await fixture();
  try {
    await writeFile(join(outside.cwd, 'secret'), 'outside');
    await symlink(outside.cwd, join(ws.cwd, 'escape'));
    await link(join(outside.cwd, 'secret'), join(ws.cwd, 'hard'));
    for (const path of ['escape/secret', 'hard']) await assert.rejects(surfaceFiles(ws, 'read', { path }, signal()), conflict);
    await writeFile(join(ws.cwd, 'binary'), Buffer.from([0, 1])); await writeFile(join(ws.cwd, 'large'), 'a'.repeat(65537));
    for (const path of ['binary', 'large']) {
      const result = await surfaceFiles(ws, 'read', { path }, signal()) as SurfaceFile;
      assert.equal(result.unavailableReason, path); assert.equal(result.text, ''); assert.equal(result.version, null);
    }
    await assert.rejects(surfaceFiles({ ...ws, identity: { dev: ws.identity.dev, ino: ws.identity.ino + 1 } }, 'tree', { path: '', offset: 0 }, signal()), conflict);
  } finally { await ws.cleanup(); await outside.cleanup(); }
});
test('strict surface inputs reject foreign fields, traversal and malformed versions', () => {
  for (const path of ['../a', '/a', '.git/config', 'a\\b']) assert.throws(() => parseSurfaceInput('read', { path }));
  assert.throws(() => parseSurfaceInput('tree', { path: '', offset: 0, cwd: '/' }));
  assert.throws(() => parseSurfaceInput('write', { path: 'a', text: 'x', expectedVersion: 'bad' }));
  assert.throws(() => parseSurfaceInput('read', { path: 'a', taskId: 'bad' }));
});
