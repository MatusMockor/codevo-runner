import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalService } from '../src/application/terminal-service.js';
import { NodePtyFactory } from '../src/infrastructure/terminal/node-pty.js';
import { stat } from 'node:fs/promises';
import type { TerminalProcessFactory } from '../src/application/terminal-ports.js';
function fixture() {
  let data = (_: string) => {}; let exit = (_: number | null) => {}; let closes = 0; let starts = 0; let valid = true;
  const writes: string[] = [];
  const resolver = { async resolve() { return { cwd: '/tmp', identity: { dev: 1, ino: 1 }, async revalidate() { if (!valid) throw new Error('revoked'); } }; } };
  const factory: TerminalProcessFactory = { async open(_workspace, _size, onData, onExit) { starts++; data = onData; exit = onExit; return { write(value) { writes.push(value); }, resize() {}, close() { closes++; } }; } };
  const service = new TerminalService(resolver, factory);
  return { service, emit: (value: string) => data(value), exit: () => exit(0), revoke: () => { valid = false; }, starts: () => starts, closes: () => closes, writes };
}
test('terminal open is single primary per scope, including concurrent requests and reconnect', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.service.open('a', { cols: 80, rows: 24 }), f.service.open('a', { cols: 80, rows: 24 })]);
    assert.equal(a.id, b.id); assert.equal(f.starts(), 1);
    assert.equal((await f.service.open('a', { cols: 80, rows: 24 })).id, a.id);
    await assert.rejects(f.service.read('b', a.id, 0), /not_found/);
    await f.service.input('a', a.id, { data: 'ls\r' }); assert.deepEqual(f.writes, ['ls\r']);
    f.exit(); assert.notEqual((await f.service.open('a', { cols: 80, rows: 24 })).id, a.id);
  } finally { await f.service.close(); }
});
test('terminal replay is bounded, utf8 safe, cursor paginated and truncation explicit', async () => {
  const f = fixture();
  try {
    const session = await f.service.open('a', { cols: 80, rows: 24 });
    f.emit('🙂'.repeat(300_000));
    const page = await f.service.read('a', session.id, 0);
    assert.equal(page.truncated, true); assert.ok(Buffer.byteLength(page.chunks.map(c => c.data).join('')) <= 262144);
    assert.ok(page.chunks.every(chunk => !chunk.data.includes('\ufffd')));
    const next = await f.service.read('a', session.id, page.chunks.at(-1)!.sequence);
    assert.equal(next.truncated, false); assert.ok(next.chunks.length > 0);
    await assert.rejects(f.service.read('a', session.id, session.sequence + 99999), /invalid_input/);
  } finally { await f.service.close(); }
});
test('terminal validates input and revokes exact workspace before writing', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.open('a', { cols: 1, rows: 24 }), /invalid_input/);
    const session = await f.service.open('a', { cols: 80, rows: 24 });
    await assert.rejects(f.service.input('a', session.id, { data: 'x'.repeat(65537) }), /invalid_input/);
    f.revoke(); await assert.rejects(f.service.input('a', session.id, { data: 'x' }), /revoked/);
    assert.equal(f.closes(), 1); assert.equal(f.writes.length, 0);
  } finally { await f.service.close(); }
});
test('PTY runs an interactive shell and accepts stdin with real terminal semantics', async () => {
  const cwd = process.cwd(); const info = await stat(cwd);
  const workspace = { cwd, identity: { dev: info.dev, ino: info.ino }, async revalidate() {} };
  let output = ''; let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const terminal = await new NodePtyFactory().open(workspace, { cols: 90, rows: 25 }, data => { output += data; if (/PTY_IS_REAL\r?\n/.test(output)) complete(); }, () => complete());
  try { terminal.write("test -t 0 && printf 'PTY_IS_REAL\\n'\r"); await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref())]); assert.match(output, /PTY_IS_REAL\r?\n/); }
  finally { terminal.close(); }
});
test('terminal rejects wrong task identity even within same project', async () => {
  const f = fixture(); const taskId = '11111111-1111-4111-8111-111111111111';
  try {
    const session = await f.service.open('a', { cols: 80, rows: 24, taskId });
    await assert.rejects(f.service.read('a', session.id, 0), /not_found/);
    await assert.rejects(f.service.input('a', session.id, { data: 'x' }), /not_found/);
    await assert.rejects(f.service.resize('a', session.id, { cols: 90, rows: 24 }), /not_found/);
    assert.throws(() => f.service.closeSession('a', session.id), /not_found/);
    assert.equal((await f.service.read('a', session.id, 0, taskId)).taskId, taskId);
  } finally { await f.service.close(); }
});
test('terminal concurrent opening quota prevents more than sixteen owned processes', async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => f.service.open(String(index), { cols: 80, rows: 24 })));
    assert.ok(results.filter(result => result.status === 'fulfilled').length <= 16);
    assert.ok(f.starts() <= 16); assert.ok(results.some(result => result.status === 'rejected'));
  } finally { await f.service.close(); }
});
test('PTY fails closed when actual outstanding input reaches its bounded queue', async () => {
  const cwd = process.cwd(); const info = await stat(cwd);
  let output = ''; let ready!: () => void;
  const stopped = new Promise<void>(resolve => { ready = resolve; });
  const terminal = await new NodePtyFactory().open({ cwd, identity: info, async revalidate() {} }, { cols: 80, rows: 24 }, data => { output += data; if (/PAUSED_SHELL\r?\n/.test(output)) ready(); }, () => {});
  try {
    terminal.write("printf 'PAUSED_SHELL\\n'; kill -STOP $$\r");
    await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref())]);
    let blocked = false;
    for (let count = 0; count < 10; count++) { try { terminal.write('x'.repeat(65536)); } catch (error) { assert.match(String(error), /busy/); blocked = true; break; } }
    assert.equal(blocked, true);
  } finally { terminal.close(); }
});
test('PTY rejects a replaced workspace identity before launching the shell', async () => {
  const cwd = process.cwd(); const info = await stat(cwd);
  let output = ''; let ended!: (code: number | null) => void;
  const done = new Promise<number | null>(resolve => { ended = resolve; });
  const terminal = await new NodePtyFactory().open({ cwd, identity: { dev: info.dev, ino: info.ino + 1 }, async revalidate() {} }, { cols: 80, rows: 24 }, data => { output += data; }, ended);
  try {
    const code = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref())]);
    assert.equal(code, 125); assert.match(output, /workspace_identity_changed/);
  } finally { terminal.close(); }
});
