import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileInstructionWorkspace } from '../src/infrastructure/files/instruction-workspace.js';
import type { InstructionSnapshot } from '../src/domain/instructions.js';

const fsTest = (name: string, fn: (t: import('node:test').TestContext) => Promise<void>) => test(name, { skip: process.platform !== 'linux' }, fn);
const snapshot = (files: Record<string, string>): InstructionSnapshot => ({ version: 1, files: Object.entries(files).map(([path, content]) => ({ scope: 'project', path, content })) });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'instruction-workspace-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, 'project'); const data = join(base, 'data');
  await mkdir(cwd); await mkdir(data);
  const service = new FileInstructionWorkspace(data); const id = randomUUID();
  const apply = (files: Record<string, string>, signal = new AbortController().signal) => service.apply(id, cwd, snapshot(files), signal);
  return { base, cwd, data, id, apply, service };
}
fsTest('reconciles changed and removed managed files without touching other project files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'keep.txt'), 'keep');
  await f.apply({ 'CLAUDE.md': 'first', '.claude/rules/a.md': 'rule' });
  await f.apply({ 'CLAUDE.md': 'second' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'second');
  await assert.rejects(readFile(join(f.cwd, '.claude/rules/a.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.cwd, 'keep.txt'), 'utf8'), 'keep');
});
fsTest('preflights every collision before changing any file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'server');
  await assert.rejects(f.apply({ 'new.md': 'new', 'CLAUDE.md': 'local' }), { code: 'conflict' });
  await assert.rejects(readFile(join(f.cwd, 'new.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'server');
});
fsTest('adopts matching files but preserves externally edited managed files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'same');
  await f.apply({ 'CLAUDE.md': 'same' });
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'external');
  await assert.rejects(f.apply({}), { code: 'conflict' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'external');
});
fsTest('rejects symlink targets, ancestor symlinks, and hardlinks', async t => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside.md'); await writeFile(outside, 'outside');
  await symlink(outside, join(f.cwd, 'CLAUDE.md'));
  await assert.rejects(f.apply({ 'CLAUDE.md': 'replacement' }), { code: 'conflict' });
  await symlink(f.base, join(f.cwd, 'linked'));
  await assert.rejects(f.apply({ 'linked/new.md': 'replacement' }), { code: 'conflict' });
  await link(outside, join(f.cwd, 'hard.md'));
  await assert.rejects(f.apply({ 'hard.md': 'outside' }), { code: 'conflict' });
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});
fsTest('already cancelled input does not change checkout', async t => {
  const f = await fixture(t); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.apply({ 'CLAUDE.md': 'new' }, abort.signal), { name: 'AbortError' });
  await assert.rejects(readFile(join(f.cwd, 'CLAUDE.md')), { code: 'ENOENT' });
});
fsTest('recovers journalled partial writes while refusing unrecognized bytes', async t => {
  const f = await fixture(t);
  await f.apply({ 'CLAUDE.md': 'old', 'remove.md': 'old' });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifestPath = join(f.data, 'instruction-manifests', `${f.id}.json`);
  await writeFile(manifestPath, JSON.stringify({ version: 1, root: f.cwd, files: { 'CLAUDE.md': hash('old'), 'remove.md': hash('old') }, pending: { 'CLAUDE.md': hash('new'), 'added.md': hash('added') } }));
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'new');
  await rm(join(f.cwd, 'remove.md'));
  await f.apply({ 'CLAUDE.md': 'new', 'added.md': 'added' });
  assert.equal(await readFile(join(f.cwd, 'added.md'), 'utf8'), 'added');
  const journal = JSON.parse(await readFile(manifestPath, 'utf8'));
  journal.pending = { 'CLAUDE.md': hash('third') };
  await writeFile(manifestPath, JSON.stringify(journal));
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'external');
  await assert.rejects(f.apply({ 'CLAUDE.md': 'third' }), { code: 'conflict' });
});
fsTest('materializes globals inside checkout and removes their managed copies', async t => {
  const f = await fixture(t);
  await f.service.apply(f.id, f.cwd, { version: 1, files: [
    { scope: 'global', path: 'CLAUDE.md', content: 'global' },
    { scope: 'global', path: 'rules/style.md', content: 'style' },
  ] }, new AbortController().signal);
  assert.equal(await readFile(join(f.cwd, '.codevo-instructions/global/CLAUDE.md'), 'utf8'), 'global');
  assert.equal(await readFile(join(f.cwd, '.claude/rules/codevo-global/style.md'), 'utf8'), 'style');
  await f.apply({});
  await assert.rejects(readFile(join(f.cwd, '.codevo-instructions/global/CLAUDE.md')), { code: 'ENOENT' });
});

fsTest('first synchronization may replace pristine HEAD instructions but preserves server edits', async t => {
  const f = await fixture(t);
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: f.cwd });
  await git('init');
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'committed');
  await writeFile(join(f.cwd, 'dirty.md'), 'committed');
  await git('add', 'CLAUDE.md', 'dirty.md');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await f.apply({ 'CLAUDE.md': 'local change' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'local change');
  await writeFile(join(f.cwd, 'dirty.md'), 'server change');
  await assert.rejects(f.apply({ 'CLAUDE.md': 'local change', 'dirty.md': 'local change' }), { code: 'conflict' });
  assert.equal(await readFile(join(f.cwd, 'dirty.md'), 'utf8'), 'server change');
});

test('fails closed when descriptor-relative directory operations are unavailable', { skip: process.platform === 'linux' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.apply({ 'CLAUDE.md': 'new' }), { code: 'storage_unavailable' });
  await assert.rejects(readFile(join(f.cwd, 'CLAUDE.md')), { code: 'ENOENT' });
});

fsTest('ancestor swap during an atomic write never redirects writes outside the retained directory', async t => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(outside);
  await mkdir(join(outside, 'rules'));
  const originalOpen = fs.open;
  let swapped = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (!swapped && String(args[0]).includes('.codevo-sync-')) {
      const resolved = await realpath(String(args[0]));
      if (resolved.startsWith(join(f.cwd, '.claude') + '/')) {
        swapped = true;
        await fs.rename(join(f.cwd, '.claude'), join(f.cwd, 'detached'));
        await symlink(outside, join(f.cwd, '.claude'));
      }
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.apply({ '.claude/rules/a.md': 'new rule' }), { code: 'conflict' });
    assert.equal(swapped, true);
    await assert.rejects(readFile(join(outside, 'rules/a.md')), { code: 'ENOENT' });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

fsTest('uppercase Markdown imports remain managed across resumed reconciliation', async t => {
  const f = await fixture(t);
  await f.apply({'CLAUDE.md':'@docs/RULES.MD','docs/RULES.MD':'first'});
  await f.apply({'CLAUDE.md':'@docs/RULES.MD','docs/RULES.MD':'second'});
  assert.equal(await readFile(join(f.cwd,'docs/RULES.MD'),'utf8'),'second');
  await f.apply({});
  await assert.rejects(readFile(join(f.cwd,'docs/RULES.MD')), {code:'ENOENT'});
});

fsTest('in-place ownership follows checkout across conversations and service restarts', async t => {
  const f = await fixture(t);
  const apply = (service: FileInstructionWorkspace, files: Record<string, string>) =>
    service.apply(randomUUID(), f.cwd, snapshot(files), new AbortController().signal, 'in-place');
  await apply(f.service, { 'CLAUDE.local.md': 'first', 'remove.md': 'old' });
  await apply(new FileInstructionWorkspace(f.data), { 'CLAUDE.local.md': 'second' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.local.md'), 'utf8'), 'second');
  await assert.rejects(readFile(join(f.cwd, 'remove.md')), { code: 'ENOENT' });
  await apply(f.service, {});
  await assert.rejects(readFile(join(f.cwd, 'CLAUDE.local.md')), { code: 'ENOENT' });
});

fsTest('in-place never adopts matching user files or removes them on an empty snapshot', async t => {
  const f = await fixture(t);
  const apply = (files: Record<string, string>) => f.service.apply(randomUUID(), f.cwd, snapshot(files), new AbortController().signal, 'in-place');
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'user rules');
  await apply({ 'CLAUDE.md': 'user rules', 'CLAUDE.local.md': 'managed' });
  await apply({});
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'user rules');
  await assert.rejects(readFile(join(f.cwd, 'CLAUDE.local.md')), { code: 'ENOENT' });
  await assert.rejects(apply({ 'CLAUDE.md': 'different' }), { code: 'conflict' });
});

fsTest('in-place rejects replacing pristine tracked instructions before writing other files', async t => {
  const f = await fixture(t);
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: f.cwd });
  await git('init');
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'committed');
  await git('add', 'CLAUDE.md');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await assert.rejects(f.service.apply(f.id, f.cwd, snapshot({ 'new.md': 'new', 'CLAUDE.md': 'replacement' }), new AbortController().signal, 'in-place'), { code: 'conflict' });
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'committed');
  await assert.rejects(readFile(join(f.cwd, 'new.md')), { code: 'ENOENT' });
});

fsTest('in-place root replacement does not inherit old managed file ownership', async t => {
  const f = await fixture(t);
  const apply = (files: Record<string, string>) => f.service.apply(f.id, f.cwd, snapshot(files), new AbortController().signal, 'in-place');
  await apply({ 'CLAUDE.md': 'original' });
  await fs.rename(f.cwd, join(f.base, 'old-root'));
  await mkdir(f.cwd);
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'original');
  await apply({});
  assert.equal(await readFile(join(f.cwd, 'CLAUDE.md'), 'utf8'), 'original');
  await assert.rejects(apply({ 'CLAUDE.md': 'replacement' }), { code: 'conflict' });
});

test('non-Linux in-place checkout allows only empty instruction reconciliation', { skip: process.platform === 'linux' }, async t => {
  const f = await fixture(t);
  await f.service.apply(f.id, f.cwd, snapshot({}), new AbortController().signal, 'in-place');
  await assert.rejects(f.service.apply(f.id, f.cwd, snapshot({ 'CLAUDE.md': 'new' }), new AbortController().signal, 'in-place'), { code: 'storage_unavailable' });
  await assert.rejects(f.service.apply(f.id, f.cwd, snapshot({}), new AbortController().signal), { code: 'storage_unavailable' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.service.apply(f.id, f.cwd, snapshot({}), abort.signal, 'in-place'), { name: 'AbortError' });
});

fsTest('in-place refuses root replaced after workspace preparation before creating sync state', async t => {
  const f = await fixture(t);
  const expectedIdentity = await fs.lstat(f.cwd);
  await fs.rename(f.cwd, join(f.base, 'prepared-root'));
  await mkdir(f.cwd);
  await assert.rejects(f.service.apply(f.id, f.cwd, snapshot({ 'CLAUDE.md': 'new' }), new AbortController().signal, 'in-place', expectedIdentity), { code: 'conflict' });
  await assert.rejects(readFile(join(f.cwd, 'CLAUDE.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.data, 'instruction-manifests')), { code: 'ENOENT' });
});
