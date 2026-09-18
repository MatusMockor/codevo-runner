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


test('provider-exit completion drains background output and later results after initial success', async () => {
  const f = await fixture(`process.stdin.resume();console.log(JSON.stringify({phase:'initial'}));
    process.stdin.on('end',()=>setTimeout(()=>{
      console.log(JSON.stringify({phase:'background'}));
      console.log(JSON.stringify({phase:'final'}));
    },80));`);
  const phases: unknown[] = [];
  try {
    const result = await runInteractiveProcess({ ...f, completion: 'provider-exit' }, {
      start: async () => {}, receive: async frame => {
        phases.push(frame.phase);
        return frame.phase === 'background' ? undefined : { exitCode: 0, sessionId: String(frame.phase) };
      } });
    assert.deepEqual(phases, ['initial', 'background', 'final']);
    assert.deepEqual(result, { exitCode: 0, sessionId: 'final' });
  } finally { await f.close(); }
});

for (const reason of ['cancelled', 'execution_timeout'] as const) {
  test(`provider-exit ${reason} remains authoritative after an early successful result`, async () => {
    const f = await fixture(`process.stdin.resume();console.log('{}');setInterval(()=>{},1000);`);
    const abort = new AbortController();
    let received = false;
    try {
      const result = await runInteractiveProcess({ ...f, completion: 'provider-exit', signal: abort.signal, timeoutMs: reason === 'cancelled' ? 15_000 : 3_000 }, {
        start: async () => {}, receive: async () => {
          received = true;
          if (reason === 'cancelled') setTimeout(() => abort.abort(), 20);
          return { exitCode: 0 };
        } });
      assert.equal(received, true);
      assert.equal(result.error, reason);
    } finally { await f.close(); }
  });
}

test('provider-exit nonzero exit cannot disguise an early success', async () => {
  const f = await fixture(`process.stdin.resume();console.log('{}');process.stdin.on('end',()=>process.exit(9));`);
  try {
    const result = await runInteractiveProcess({ ...f, completion: 'provider-exit' }, {
      start: async () => {}, receive: async () => ({ exitCode: 0 }) });
    assert.deepEqual(result, { exitCode: 9, error: 'provider_reported_failure' });
  } finally { await f.close(); }
});

test('provider-exit protocol failure remains terminal after an early success', async () => {
  const f = await fixture(`process.stdin.resume();console.log(JSON.stringify({phase:'initial'}));
    process.stdin.on('end',()=>console.log(JSON.stringify({phase:'failed'})));setInterval(()=>{},1000);`);
  try {
    const result = await runInteractiveProcess({ ...f, completion: 'provider-exit' }, {
      start: async () => {}, receive: async frame => frame.phase === 'initial'
        ? { exitCode: 0 } : { exitCode: null, error: 'provider_question_cancelled' } });
    assert.deepEqual(result, { exitCode: null, error: 'provider_question_cancelled' });
  } finally { await f.close(); }
});

test('Claude process keeps stdin through background notification and delayed final answer', async () => {
  const { executeClaudeInteractive } = await import('../src/infrastructure/execution/claude-interactive.js');
  const session = '01998cf0-1111-7111-8111-111111111111';
  const f = await fixture(`
    const emit = value => console.log(JSON.stringify(value));
    const session = '${session}';
    let timer;
    process.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\\n')) {
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') emit({type:'control_response',response:{subtype:'success',request_id:'codevo-initialize'}});
        if (frame.type === 'user') {
          emit({type:'system',subtype:'init',session_id:session});
          emit({type:'system',subtype:'task_started',task_id:'watch',task_type:'local_bash',session_id:session});
          emit({type:'result',subtype:'success',is_error:false,session_id:session});
          timer = setTimeout(() => {
            emit({type:'system',subtype:'task_notification',task_id:'watch',status:'completed',session_id:session});
            emit({type:'assistant',message:{content:[{type:'text',text:'Pipeline finished'}]}});
            emit({type:'result',subtype:'success',is_error:false,session_id:session});
          },80);
        }
      }
    });
    process.stdin.on('end',()=>{ clearTimeout(timer); process.exit(0); });
  `);
  const output: string[] = [];
  try {
    const result = await executeClaudeInteractive({ ...f, prompt: 'watch', images: [], request: {
      task: { id: session, runnerId: session, sequence: 1, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
      cwd: f.cwd, signal: f.signal, attachments: [], onOutput: async (_channel, text) => { output.push(text); },
    } });
    assert.deepEqual(result, { exitCode: 0, sessionId: session });
    assert.ok(output.join('').includes('Pipeline finished'));
    assert.equal(output.filter(line => line.includes('"type":"result"')).length, 2);
  } finally { await f.close(); }
});

test('Stop cancels Claude with real background work retained after foreground result', async () => {
  const { executeClaudeInteractive } = await import('../src/infrastructure/execution/claude-interactive.js');
  const session = '01998cf0-1111-7111-8111-111111111111';
  const f = await fixture(`process.stdin.resume();
    for (const event of [
      {type:'system',subtype:'init',session_id:'${session}'},
      {type:'system',subtype:'task_started',task_id:'watch'},
      {type:'result',subtype:'success',is_error:false,session_id:'${session}'}
    ]) console.log(JSON.stringify(event));
    setInterval(()=>{},1000);`);
  const abort = new AbortController();
  try {
    const result = await executeClaudeInteractive({ ...f, signal: abort.signal, prompt: 'watch', images: [], request: {
      task: { id: session, runnerId: session, sequence: 1, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
      cwd: f.cwd, signal: abort.signal, attachments: [], onOutput: async (_channel, text) => {
        if (text.includes('"type":"result"')) setTimeout(() => abort.abort(), 20);
      },
    } });
    assert.equal(result.error, 'cancelled');
  } finally { await f.close(); }
});
