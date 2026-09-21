import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepositoryCli } from '../src/infrastructure/projects/repository-lookup.js';

test('repository CLI enforces process/output/cancellation/UTF-8 boundaries', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repository-cli-'));
  const previousPath = process.env.PATH;
  const path = join(directory, 'gh');
  const fixture = async (source: string) => {
    await writeFile(path, `#!${process.execPath}\n${source}\n`); await chmod(path, 0o700);
  };
  process.env.PATH = directory;
  try {
    await fixture("process.stdout.write(Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xff,0x22,0x7d]));");
    assert.equal((await runRepositoryCli('gh', [], new AbortController().signal)).failure, 'invalidOutput');
    await fixture("process.stdout.write(Buffer.alloc(300000, 65)); setInterval(() => {},1000);");
    assert.equal((await runRepositoryCli('gh', [], new AbortController().signal)).failure, 'outputTooLarge');
    await fixture("setInterval(() => {},1000);");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    try { assert.equal((await runRepositoryCli('gh', [], abort.signal)).failure, 'timedOut'); }
    finally { clearTimeout(timer); }
    await fixture("require('node:child_process').spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'inherit'}); process.exit(0);");
    const started = Date.now();
    assert.equal((await runRepositoryCli('gh', [], new AbortController().signal)).code, 0);
    assert.ok(Date.now() - started < 2000, 'parent exit must terminate descendants retaining pipes');
    await rm(path);
    assert.equal((await runRepositoryCli('gh', [], new AbortController().signal)).failure, 'cliMissing');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
