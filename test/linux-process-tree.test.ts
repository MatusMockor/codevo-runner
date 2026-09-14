import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProcess } from '../src/infrastructure/execution/process-runner.js';

for (const reason of ['cancel', 'timeout', 'parent-exit'] as const) {
  test(`Linux ${reason} owns nested detached groups and leaves unrelated process alive`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codevo-detached-'));
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const abort = new AbortController();
    const leaf = `require('node:fs').writeFileSync('leaf.pid',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('orphan','bad'),1200);setInterval(()=>{},1000)`;
    const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'inherit'});setInterval(()=>{},1000)`;
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'inherit'});setTimeout(()=>console.log('ready'),400);${reason === 'parent-exit' ? 'setTimeout(()=>process.exit(0),550)' : 'setInterval(()=>{},1000)'}`;
    try {
      await writeFile(join(cwd, 'provider.cjs'), script);
      const result = await runProcess({ executable: process.execPath, args: [join(cwd, 'provider.cjs')], cwd, stdin: '', env: process.env,
        signal: abort.signal, timeoutMs: reason === 'timeout' ? 600 : 3000, outputBytes: 10000,
        onOutput: async () => { if (reason === 'cancel') abort.abort(); } });
      assert.equal(result.error, reason === 'cancel' ? 'cancelled' : reason === 'timeout' ? 'execution_timeout' : undefined);
      await new Promise(resolve => setTimeout(resolve, 1300));
      await assert.rejects(readFile(join(cwd, 'orphan')));
      const pid = Number(await readFile(join(cwd, 'leaf.pid'), 'utf8'));
      // A subreaper may retain a zombie briefly; it must no longer execute.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '));
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    } finally {
      abort.abort(); unrelated.kill('SIGKILL');
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('Linux cleanup failure takes precedence over cancellation', { skip: process.platform !== 'linux' }, async () => {
  const { LinuxProcessTree } = await import('../src/infrastructure/execution/linux-process-tree.js');
  const original = LinuxProcessTree.prototype.kill;
  LinuxProcessTree.prototype.kill = function () { original.call(this); throw new Error('injected inspection failure'); };
  const abort = new AbortController();
  try {
    const result = await runProcess({ executable: process.execPath, args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
      cwd: tmpdir(), stdin: '', env: process.env, signal: abort.signal, timeoutMs: 3000, outputBytes: 10000,
      onOutput: async () => { abort.abort(); } });
    assert.equal(result.error, 'process_cleanup_failed');
  } finally { LinuxProcessTree.prototype.kill = original; abort.abort(); }
});
