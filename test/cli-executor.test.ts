import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Task } from '../src/domain/contracts.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';

const sessionId = '01998cf0-1111-7111-8111-111111111111';
function providerSuccess(provider: 'codex' | 'claude', id = sessionId): string {
  const frames = provider === 'codex'
    ? [{ type: 'thread.started', thread_id: id }, { type: 'turn.completed' }]
    : [{ type: 'system', subtype: 'init', session_id: id }, { type: 'result', subtype: 'success', is_error: false, session_id: id }];
  return frames.map(frame => `console.log(${JSON.stringify(JSON.stringify(frame))});`).join('\n');
}

async function fixture(script: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'codevo-cli-'));
  const executable = join(cwd, 'fake-provider');
  await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  const task: Task = { id: randomUUID(), sequence: 1, runnerId: 'runner', provider: 'codex',
    status: 'draft', parts: [{ type: 'text', text: 'inspect $(touch bad); --dangerous' }], createdAt: new Date().toISOString() };
  let output = '';
  const request: ExecutionRequest = { task, cwd, attachments: [], signal: new AbortController().signal,
    onOutput: async (_channel, text) => { output += text; } };
  return { cwd, executable, request, output: () => output, close: () => rm(cwd, { recursive: true, force: true }) };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} sends literal prompts/images and executes in assigned workspace`, async () => {
    const f = await fixture(`let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
      console.log(JSON.stringify({args:process.argv.slice(2),stdin,cwd:process.cwd(),secret:process.env.CODEVO_RUNNER_TOKEN,bgWait:process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,type:'diagnostic'}));
      ${providerSuccess(provider)}
    });`);
    try {
      const path = join(f.cwd, 'image.png');
      const id = randomUUID();
      await writeFile(path, Buffer.from([137, 80, 78, 71]));
      const result = await new CliProviderExecutor(provider, { executable: f.executable }).execute({ ...f.request,
        task: { ...f.request.task, provider, parts: [...f.request.task.parts, { type: 'attachment', attachmentId: id }] },
        attachments: [{ id, path, mediaType: 'image/png' }] });
      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      const observed = JSON.parse(f.output().split('\n')[0]!);
      assert.equal(observed.cwd, await realpath(f.cwd));
      assert.equal(observed.secret, undefined);
      assert.equal(observed.bgWait, provider === 'claude' ? '0' : undefined);
      if (provider === 'codex') {
        assert.deepEqual(observed.args.slice(-4), ['-i', path, '--', '-']);
        assert.ok(observed.stdin.endsWith('[User request]\ninspect $(touch bad); --dangerous'));
        assert.match(observed.stdin, /^\[Codevo presentation capability\]/);
      }
      if (provider === 'claude') {
        const hintIndex = observed.args.indexOf('--append-system-prompt');
        assert.ok(hintIndex > 0);
        assert.match(observed.args[hintIndex + 1], /workspace-relative Markdown/);
        const frame = JSON.parse(observed.stdin);
        assert.equal(frame.message.content[0].source.data, 'iVBORw==');
        assert.equal(frame.message.content[1].text, 'inspect $(touch bad); --dangerous');
      }
      await assert.rejects(readFile(join(f.cwd, 'bad')));
    } finally { await f.close(); }
  });
}

test('missing and symbolic link image inputs fail before CLI spawn', async () => {
  const f = await fixture('require("node:fs").writeFileSync("spawned","bad")');
  try {
    const executor = new CliProviderExecutor('codex', { executable: f.executable });
    const id = randomUUID();
    const task: Task = { ...f.request.task, parts: [{ type: 'attachment', attachmentId: id }] };
    assert.equal((await executor.execute({ ...f.request, task })).error, 'attachment_input_invalid');
    await symlink(f.executable, join(f.cwd, 'image.png'));
    assert.equal((await executor.execute({ ...f.request, task, attachments: [{ id, path: join(f.cwd, 'image.png'), mediaType: 'image/png' }] })).error, 'attachment_input_invalid');
    await assert.rejects(readFile(join(f.cwd, 'spawned')));
  } finally { await f.close(); }
});

test('external container isolation requires explicit trusted operator configuration', async () => {
  const f = await fixture('console.log(JSON.stringify(process.argv.slice(2)))');
  try {
    await new CliProviderExecutor('codex', { executable: f.executable, sandbox: 'external-sandbox' }).execute(f.request);
    const args: string[] = JSON.parse(f.output());
    assert.ok(args.includes('sandbox_mode="danger-full-access"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  } finally { await f.close(); }
});

test('Claude image-only task sends no empty text block', async () => {
  const f = await fixture('process.stdin.pipe(process.stdout)');
  try {
    const path = join(f.cwd, 'image.png');
    const id = randomUUID();
    await writeFile(path, Buffer.from([137, 80, 78, 71]));
    const result = await new CliProviderExecutor('claude', { executable: f.executable }).execute({ ...f.request,
      task: { ...f.request.task, provider: 'claude', parts: [{ type: 'attachment', attachmentId: id }] },
      attachments: [{ id, path, mediaType: 'image/png' }] });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(f.output()).message.content, [{ type: 'image', source: {
      type: 'base64', media_type: 'image/png', data: 'iVBORw==',
    } }]);
  } finally { await f.close(); }
});

test('Codex image-only task supplies the prompt required by exec', async () => {
  const f = await fixture('process.stdin.pipe(process.stdout)');
  try {
    const path = join(f.cwd, 'image.png');
    const id = randomUUID();
    await writeFile(path, Buffer.from([137, 80, 78, 71]));
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request,
      task: { ...f.request.task, parts: [{ type: 'attachment', attachmentId: id }] },
      attachments: [{ id, path, mediaType: 'image/png' }] });
    assert.equal(result.exitCode, 0);
    assert.ok(f.output().endsWith('[User request]\nInspect the attached images.'));
  } finally { await f.close(); }
});

test('output overflow terminates provider and never reports success', async () => {
  const f = await fixture('setInterval(()=>process.stdout.write("x".repeat(4096)),1)');
  try {
    const result = await new CliProviderExecutor('codex', { executable: f.executable, outputBytes: 1000 }).execute(f.request);
    assert.equal(result.error, 'output_limit_exceeded');
    assert.ok(Buffer.byteLength(f.output()) <= 1000);
  } finally { await f.close(); }
});

for (const reason of ['cancel', 'timeout', 'parent-exit'] as const) {
  test(`${reason} kills descendants, including inherited output pipes`, async () => {
    const f = await fixture(`const cp=require('node:child_process');
      cp.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('orphan','bad'),650);setInterval(()=>{},1000)"],{stdio:'inherit'});
      console.log('ready');
      ${reason === 'parent-exit' ? 'setTimeout(()=>process.exit(0),40)' : 'setInterval(()=>{},1000)'};`);
    const abort = new AbortController();
    try {
      const result = await new CliProviderExecutor('codex', { executable: f.executable, timeoutMs: reason === 'timeout' ? 200 : 3000 })
        .execute({ ...f.request, signal: abort.signal, onOutput: async () => { if (reason === 'cancel') abort.abort(); } });
      if (reason === 'cancel') assert.equal(result.error, 'cancelled');
      if (reason === 'timeout') assert.equal(result.error, 'execution_timeout');
      if (reason === 'parent-exit') assert.equal(result.exitCode, 0);
      await new Promise(resolve => setTimeout(resolve, 750));
      await assert.rejects(readFile(join(f.cwd, 'orphan')));
    } finally { abort.abort(); await f.close(); }
  });
}

test('failed output persistence stops the provider and reports failure', async () => {
  const f = await fixture('console.log("ready");setInterval(()=>{},1000)');
  try {
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request,
      onOutput: async () => { throw new Error('database unavailable'); } });
    assert.equal(result.error, 'output_persistence_failed');
  } finally { await f.close(); }
});

test('missing executable and pre-aborted request settle without leaking a process', async () => {
  const f = await fixture('setInterval(()=>{},1000)');
  try {
    const result = await new CliProviderExecutor('codex', { executable: join(f.cwd, 'missing') }).execute(f.request);
    assert.equal(result.error, 'provider_unavailable');
    const abort = new AbortController(); abort.abort();
    assert.equal((await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request, signal: abort.signal })).error, 'cancelled');
  } finally { await f.close(); }
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} resumes exact session with stdin, image flags and original workspace`, async () => {
    const f = await fixture(`let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
      require('node:fs').writeFileSync('arguments.json',JSON.stringify({args:process.argv.slice(2),stdin,cwd:process.cwd()}));
      ${providerSuccess(provider)}
    });`);
    try {
      const path = join(f.cwd, 'image.png'); const id = randomUUID();
      await writeFile(path, Buffer.from([137, 80, 78, 71]));
      const result = await new CliProviderExecutor(provider, { executable: f.executable }).execute({ ...f.request,
        resumeSessionId: sessionId,
        task: { ...f.request.task, provider, parts: [...f.request.task.parts, { type: 'attachment', attachmentId: id }] },
        attachments: [{ id, path, mediaType: 'image/png' }] });
      assert.deepEqual(result, { exitCode: 0, sessionId });
      const observed = JSON.parse(await readFile(join(f.cwd, 'arguments.json'), 'utf8'));
      assert.equal(observed.cwd, await realpath(f.cwd));
      if (provider === 'codex') {
        assert.deepEqual(observed.args.slice(0, 3), ['exec', 'resume', '--json']);
        assert.deepEqual(observed.args.slice(-5), ['-i', path, '--', sessionId, '-']);
        assert.ok(observed.args.includes('sandbox_mode="workspace-write"'));
        assert.ok(observed.stdin.endsWith('[User request]\ninspect $(touch bad); --dangerous'));
        assert.match(observed.stdin, /^\[Codevo presentation capability\]/);
      }
      if (provider === 'claude') {
        assert.deepEqual(observed.args.slice(-2), ['--resume', sessionId]);
        assert.equal(JSON.parse(observed.stdin).message.content[0].source.data, 'iVBORw==');
      }
    } finally { await f.close(); }
  });
  test(`${provider} zero exit does not hide structured failure or a fresh session`, async () => {
    const failure = provider === 'codex' ? { type: 'turn.failed' }
      : { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId };
    const f = await fixture(`${providerSuccess(provider)}\nconsole.log(${JSON.stringify(JSON.stringify(failure))});`);
    try {
      const executor = new CliProviderExecutor(provider, { executable: f.executable });
      const request = { ...f.request, task: { ...f.request.task, provider } };
      assert.equal((await executor.execute(request)).error, 'provider_reported_failure');
      assert.equal((await executor.execute({ ...request, resumeSessionId: randomUUID() })).error, 'provider_session_mismatch');
      assert.equal((await executor.execute({ ...request, resumeSessionId: '--last' })).error, 'provider_session_invalid');
    } finally { await f.close(); }
  });
}

test('canonical session is durably published before output and before provider completion', async () => {
  const f = await fixture(`console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));setInterval(()=>{},1000);`);
  const abort = new AbortController();
  const observed: string[] = [];
  try {
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request,
      signal: abort.signal,
      onSession: async id => { observed.push(`session:${id}`); },
      onOutput: async () => { observed.push('output'); abort.abort(); } });
    assert.deepEqual(observed, [`session:${sessionId}`, 'output']);
    assert.equal(result.error, 'cancelled');
    assert.equal(result.sessionId, sessionId);
  } finally { abort.abort(); await f.close(); }
});

test('session persistence failure stops the provider without publishing output', async () => {
  const f = await fixture(`console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));setInterval(()=>{},1000);`);
  try {
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request,
      onSession: async () => { throw new Error('repository unavailable'); } });
    assert.equal(result.error, 'output_persistence_failed');
    assert.equal(f.output(), '');
  } finally { await f.close(); }
});

test('session remains captured when a later malformed frame fails the turn', async () => {
  const f = await fixture(`const fs=require('node:fs');
    console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));
    const timer=setInterval(()=>{if(!fs.existsSync('session-captured'))return;
      clearInterval(timer);console.log('malformed later output');},5);`);
  const sessions: string[] = [];
  try {
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request,
      onSession: async id => { sessions.push(id); await writeFile(join(f.cwd, 'session-captured'), id); } });
    assert.deepEqual(sessions, [sessionId]);
    assert.equal(result.error, 'provider_output_invalid');
    assert.equal(await readFile(join(f.cwd, 'session-captured'), 'utf8'), sessionId);
  } finally { await f.close(); }
});

for (const resumed of [false, true]) {
  for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} explicit launch controls survive ${resumed ? 'resume' : 'start'} without legacy permission overrides`, async () => {
      const f = await fixture(`let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
        console.log(JSON.stringify({args:process.argv.slice(2),stdin,type:'diagnostic'}));
        ${providerSuccess(provider)}
      });`);
      try {
        const launch = provider === 'codex'
          ? { provider: 'codex' as const, model: 'gpt-5.5' as const, mode: 'readOnly' as const }
          : { provider: 'claudeCode' as const, model: 'opus' as const, mode: 'plan' as const, effort: 'high' as const, context: '1m' as const, fastMode: true };
        const result = await new CliProviderExecutor(provider, { executable: f.executable }).execute({ ...f.request,
          ...(resumed ? { resumeSessionId: sessionId } : {}), task: { ...f.request.task, provider, launch } });
        assert.equal(result.error, undefined);
        const observed = JSON.parse(f.output().split('\n')[0]!);
        if (provider === 'codex') {
          assert.deepEqual(observed.args.slice(resumed ? 3 : 2, resumed ? 7 : 6), ['-m', 'gpt-5.5', resumed ? '-c' : '--sandbox', resumed ? 'sandbox_mode="read-only"' : 'read-only']);
          assert.ok(!observed.args.includes('approval_policy="never"'));
          assert.ok(!observed.args.includes('sandbox_mode="workspace-write"'));
        }
        if (provider === 'claude') {
          assert.deepEqual(observed.args.slice(8, 16), ['--model', 'opus[1m]', '--permission-mode', 'plan', '--effort', 'high', '--settings', '{"fastMode":true}']);
          assert.ok(!observed.args.includes('--allowedTools'));
          assert.ok(!observed.args.includes('acceptEdits'));
        }
      } finally { await f.close(); }
    });
  }
}

test('invalid persisted launch fails before provider spawn', async () => {
  const f = await fixture('require("node:fs").writeFileSync("spawned","bad")');
  try {
    const launch = { provider: 'claudeCode' as const, model: 'opus' as const, mode: 'plan' as const, effort: 'high' as const };
    const result = await new CliProviderExecutor('codex', { executable: f.executable }).execute({ ...f.request, task: { ...f.request.task, launch } });
    assert.equal(result.error, 'launch_options_invalid');
    await assert.rejects(readFile(join(f.cwd, 'spawned')));
  } finally { await f.close(); }
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} refreshes instruction snapshot on resume through stdin without large argv`, async () => {
    const f = await fixture(`let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
      require('node:fs').writeFileSync('instructions.json',JSON.stringify({args:process.argv.slice(2),stdin}));
      ${providerSuccess(provider)}
    });`);
    try {
      const instructions = { version: 1 as const, files: [{ scope: 'global' as const, path: 'CLAUDE.md', content: 'Updated global instruction' }] };
      const result = await new CliProviderExecutor(provider, { executable: f.executable }).execute({ ...f.request,
        resumeSessionId: sessionId, task: { ...f.request.task, provider, instructions } });
      assert.equal(result.error, undefined);
      const observed = JSON.parse(await readFile(join(f.cwd, 'instructions.json'), 'utf8'));
      assert.match(observed.stdin, /Updated global instruction/);
      assert.match(observed.stdin, /replace earlier synchronized instruction snapshots/);
      assert.ok(!observed.args.some((arg: string) => arg.includes('Updated global instruction')));
    } finally { await f.close(); }
  });
}


test('interactive Claude waits for background completion after an early result', async () => {
  const f = await fixture(`
    const session = '${sessionId}';
    const emit = frame => console.log(JSON.stringify(frame));
    let input = '';
    process.stdin.on('data', chunk => {
      input += chunk;
      let index;
      while ((index = input.indexOf('\\n')) >= 0) {
        const frame = JSON.parse(input.slice(0,index)); input = input.slice(index+1);
        if (frame.type === 'control_request') emit({type:'control_response',response:{subtype:'success',request_id:'codevo-initialize'}});
        if (frame.type === 'user') {
          if (process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS !== '0') process.exit(8);
          emit({type:'system',subtype:'init',session_id:session});
          emit({type:'result',subtype:'success',is_error:false,session_id:session,result:''});
        }
      }
    });
    process.stdin.on('end',()=>setTimeout(()=>{
      emit({type:'system',subtype:'task_notification',status:'completed',task_id:'background-1'});
      emit({type:'result',subtype:'success',is_error:false,session_id:session,result:'Final background answer'});
    },100));
  `);
  try {
    const result = await new CliProviderExecutor('claude', { executable: f.executable, interactiveQuestions: true, timeoutMs: 15_000 })
      .execute({ ...f.request, task: { ...f.request.task, provider: 'claude' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
    assert.match(f.output(), /Final background answer/);
  } finally { await f.close(); }
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} references pasted text as a file and never emits an image input`, async () => {
    const f = await fixture(provider === 'claude' ? `
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => { const frame=JSON.parse(line);
        if(frame.type==='control_request') console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'codevo-initialize'}}));
        if(frame.type==='user') { require('node:fs').writeFileSync('captured.json',JSON.stringify(frame)); ${providerSuccess('claude')} process.exit(0); }
      });
    ` : `let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
      console.log(JSON.stringify({args:process.argv.slice(2),stdin,type:'diagnostic'}));
      ${providerSuccess(provider)}
    });`);
    try {
      const path = join(f.cwd, 'pasted.txt'); const id = randomUUID();
      await writeFile(path, 'Pasted contents\n'.repeat(3000));
      const result = await new CliProviderExecutor(provider, { executable: f.executable }).execute({ ...f.request,
        task: { ...f.request.task, provider, parts: [{ type: 'attachment', attachmentId: id }] },
        attachments: [{ id, path, mediaType: 'text/plain' }] });
      assert.equal(result.error, undefined);
      const observed = provider === 'codex' ? JSON.parse(f.output().split('\n')[0]!) : { args: [], stdin: await readFile(join(f.cwd, 'captured.json'), 'utf8') };
      assert.equal(observed.args.includes('-i'), false);
      const prompt = provider === 'codex' ? observed.stdin : JSON.parse(observed.stdin).message.content[0].text;
      assert.ok(prompt.includes(JSON.stringify(path)));
      assert.ok(!prompt.includes('Pasted contents'));
      if (provider === 'claude') assert.deepEqual(JSON.parse(observed.stdin).message.content.map((part: { type: string }) => part.type), ['text']);
    } finally { await f.close(); }
  });
}
