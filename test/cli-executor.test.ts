import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Task } from '../src/domain/contracts.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';

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
      console.log(JSON.stringify({args:process.argv.slice(2),stdin,cwd:process.cwd(),secret:process.env.CODEVO_RUNNER_TOKEN}));
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
      const observed = JSON.parse(f.output());
      assert.equal(observed.cwd, await realpath(f.cwd));
      assert.equal(observed.secret, undefined);
      if (provider === 'codex') {
        assert.deepEqual(observed.args.slice(-4), ['-i', path, '--', '-']);
        assert.equal(observed.stdin, 'inspect $(touch bad); --dangerous');
      }
      if (provider === 'claude') {
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
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
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
    assert.equal(f.output(), 'Inspect the attached images.');
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
