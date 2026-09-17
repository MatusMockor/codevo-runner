import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProcess } from '../src/infrastructure/execution/process-runner.js';
import { runInteractiveProcess } from '../src/infrastructure/execution/interactive-process.js';
import { createCodexProtocol } from '../src/infrastructure/execution/codex-interactive.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { pinnedSpawnPlan } from '../src/infrastructure/execution/pinned-spawn.js';

for (const interactive of [false, true]) {
  test(`pinned ${interactive ? 'interactive' : 'batch'} launch rejects replaced workspace`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-pinned-'));
    try {
      const cwd = join(root, 'workspace'); await mkdir(cwd);
      const identity = await stat(cwd);
      await rename(cwd, join(root, 'old')); await mkdir(cwd);
      let output = '';
      const plan = { executable: process.execPath, args: ['-e', 'console.log("PROVIDER_STARTED")'], cwd,
        cwdIdentity: { dev: identity.dev, ino: identity.ino }, env: process.env,
        signal: new AbortController().signal, timeoutMs: 5000,
        onOutput: async (_channel: string, text: string) => { output += text; } };
      const result = interactive
        ? await runInteractiveProcess(plan, { start: async () => {}, receive: async () => undefined })
        : await runProcess({ ...plan, stdin: '' });
      assert.notEqual(result.exitCode, 0);
      assert.match(output, /workspace_identity_changed/);
      assert.doesNotMatch(output, /PROVIDER_STARTED/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('pinned batch launch preserves exact provider stdin and cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'runner-pinned-'));
  try {
    const identity = await stat(cwd); let output = '';
    const stdin = 'payload\nincluding Unicode ž and JSON {"a":1}';
    const result = await runProcess({ executable: process.execPath,
      args: ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data", c=>s+=c); process.stdin.on("end",()=>console.log(JSON.stringify({s,cwd:process.cwd()})))'],
      cwd, cwdIdentity: { dev: identity.dev, ino: identity.ino }, stdin, env: process.env,
      signal: new AbortController().signal, timeoutMs: 5000,
      onOutput: async (_channel, text) => { output += text; } });
    assert.equal(result.exitCode, 0); assert.equal(result.error, undefined);
    const value = JSON.parse(output) as { s: string; cwd: string };
    assert.equal(value.s, stdin);
    assert.equal((await stat(value.cwd)).ino, identity.ino);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('pinned interactive launch preserves provider JSON protocol stdin', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'runner-pinned-'));
  try {
    const identity = await stat(cwd);
    const result = await runInteractiveProcess({ executable: process.execPath,
      args: ['-e', 'process.stdin.once("data", c=>process.stdout.write(c))'], cwd,
      cwdIdentity: { dev: identity.dev, ino: identity.ino }, env: process.env,
      signal: new AbortController().signal, timeoutMs: 5000, onOutput: async () => {} }, {
      start: async send => send({ hello: 'ž' }),
      receive: async frame => { assert.deepEqual(frame, { hello: 'ž' }); return { exitCode: 0 }; },
    });
    assert.equal(result.exitCode, 0); assert.equal(result.error, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('unpinned launch unchanged and pinned metadata bounded', () => {
  const plan = { executable: 'node', args: ['-v'], cwd: '/tmp' };
  assert.equal(pinnedSpawnPlan(plan), plan);
  assert.throws(() => pinnedSpawnPlan({ ...plan, cwdIdentity: { dev: NaN, ino: 1 } }));
  assert.throws(() => pinnedSpawnPlan({ ...plan, cwdIdentity: { dev: 1, ino: 1 }, args: ['x'.repeat(32769)] }));
});

for (const during of ['initialize', 'session', 'output'] as const) {
  test(`Codex revalidates cwd after awaited ${during} callback`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-handshake-'));
    try {
      const cwd = join(root, 'workspace'); await mkdir(cwd);
      const identity = await stat(cwd);
      const replace = async () => { await rename(cwd, join(root, 'old')); await mkdir(cwd); };
      const sent: string[] = [];
      const request: ExecutionRequest = {
        task: { id: 'task', sequence: 1, runnerId: 'runner', provider: 'codex', status: 'running', parts: [], createdAt: '' },
        attachments: [], cwd, cwdIdentity: { dev: identity.dev, ino: identity.ino },
        signal: new AbortController().signal,
        onSession: async () => { if (during === 'session') await replace(); },
        onOutput: async () => { if (during === 'output') await replace(); },
      };
      const protocol = createCodexProtocol({ executable: 'codex', cwd, env: {}, signal: request.signal,
        timeoutMs: 5000, request, prompt: '', sandbox: 'workspace-write' });
      const send = async (value: unknown) => {
        const method = (value as { method: string }).method; sent.push(method);
        if (during === 'initialize' && method === 'initialized') await replace();
      };
      await protocol.start(send);
      if (during === 'initialize') {
        await assert.rejects(protocol.receive({ id: 1, result: {} }, send), /workspace_identity_changed/);
        assert.equal(sent.includes('thread/start'), false);
      } else {
        await protocol.receive({ id: 1, result: {} }, send);
        await assert.rejects(protocol.receive({ id: 2, result: { thread: { id: '01998cf0-1111-7111-8111-111111111111' } } }, send), /workspace_identity_changed/);
        assert.equal(sent.includes('turn/start'), false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
