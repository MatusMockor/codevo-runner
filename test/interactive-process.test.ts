import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInteractiveProcess } from '../src/infrastructure/execution/interactive-process.js';

async function fixture(source: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'codevo-interactive-'));
  const executable = join(cwd, 'provider');
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { executable, args: [], cwd, env: { PATH: process.env.PATH }, timeoutMs: 15000,
    signal: new AbortController().signal, onOutput: async () => {},
    close: () => rm(cwd, { recursive: true, force: true }) };
}
test('interactive stdio remains open for provider response and completes without child exit', async () => {
  const f = await fixture(`process.stdin.on('data', chunk=>{const m=JSON.parse(chunk); console.log(JSON.stringify({answer:m.answer}));});`);
  try {
    const result = await runInteractiveProcess(f, { start: send => send({ answer: 42 }),
      receive: async frame => { assert.equal(frame.answer, 42); return { exitCode: 0 }; } });
    assert.deepEqual(result, { exitCode: 0 });
  } finally { await f.close(); }
});
test('abort reaps provider even while question callback never resolves', async () => {
  const f = await fixture(`console.log('{}');setInterval(()=>{},1000);`);
  const abort = new AbortController();
  try {
    const result = await runInteractiveProcess({ ...f, signal: abort.signal }, {
      start: async () => {}, receive: async () => { abort.abort(); return new Promise(() => {}); } });
    assert.equal(result.error, 'cancelled');
  } finally { await f.close(); }
});
test('oversized unterminated frame fails boundedly', async () => {
  const f = await fixture(`process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000);`);
  try {
    const result = await runInteractiveProcess(f, { start: async () => {}, receive: async () => undefined });
    assert.equal(result.error, 'provider_protocol_failed');
  } finally { await f.close(); }
});
test('exit without provider terminal result is not success', async () => {
  const f = await fixture(`process.exit(0);`);
  try {
    const result = await runInteractiveProcess(f, { start: async () => {}, receive: async () => undefined });
    assert.equal(result.error, 'provider_result_missing');
  } finally { await f.close(); }
});
test('terminal frame persistence drains before normal process close completes', async () => {
  const f = await fixture(`console.log('{}');process.exit(0);`);
  let persisted = false;
  try {
    const result = await runInteractiveProcess(f, { start: async () => {}, receive: async () => {
      await new Promise(resolve => setTimeout(resolve, 50)); persisted = true; return { exitCode: 0 };
    } });
    assert.equal(persisted, true); assert.deepEqual(result, { exitCode: 0 });
  } finally { await f.close(); }
});
test('outbound bound admits full attachment contract after base64 expansion and JSON escaping', async () => {
  const { INTERACTIVE_INPUT_BYTES } = await import('../src/infrastructure/execution/interactive-process.js');
  const { LIMITS } = await import('../src/domain/contracts.js');
  const base64 = 'A'.repeat(4 * Math.ceil(LIMITS.attachmentBytes / 3));
  const content = Array.from({ length: LIMITS.attachmentsPerTask }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }));
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'user', message: { role: 'user', content } }));
  assert.ok(bytes > 64 * 1024 * 1024);
  assert.ok(bytes < INTERACTIVE_INPUT_BYTES);
});
