import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createClaudeProtocol } from '../src/infrastructure/execution/claude-interactive.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
type Steer = Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];

type Frame = Record<string, unknown>;
const wire = JSON.parse(readFileSync(new URL('../../test/fixtures/claude-resumed-task-notification-wire.json', import.meta.url), 'utf8')) as {
  sequences: Record<'queuedBeforeReplayResult' | 'replayResultBeforeQueued', Frame[]>;
};
const session = '13fbeb90-ea1d-4708-9870-c2c29d58aa82';
const foreign = '01998cf0-1111-7111-8111-111111111111';

function fixture(resumeSessionId: string | undefined) {
  const sent: unknown[] = [];
  let output = '';
  let steering = 0;
  let steer: Steer;
  const request: ExecutionRequest = { task: { id: session, runnerId: session, sequence: 2, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
    cwd: '/tmp', signal: new AbortController().signal, attachments: [], ...(resumeSessionId ? { resumeSessionId } : {}),
    onOutput: async (_channel, text) => { output += text; },
    onSteeringReady: handler => { steering = handler ? steering + 1 : -1; steer = handler; } };
  const protocol = createClaudeProtocol({ executable: 'claude', args: [], cwd: '/tmp', env: {}, signal: request.signal, timeoutMs: 1000, request, prompt: 'Reply with the single word OK.', images: [] });
  const send = async (value: unknown) => { sent.push(value); };
  const initialUuid = () => (sent.find(value => (value as Frame).type === 'user') as { uuid: string }).uuid;
  const receive = (frame: Frame) => protocol.receive(frame.command_uuid === '<initial>' ? { ...frame, command_uuid: initialUuid() } : frame, send);
  return { protocol, send, sent, receive, frames: () => output.split('\n').filter(Boolean).map(line => JSON.parse(line) as Frame), steering: () => steering, steer: () => steer };
}
const isPromptResult = (frame: Frame) => frame.type === 'result' && frame.origin === undefined;

for (const [name, frames] of Object.entries(wire.sequences)) {
  test(`resumed Claude accepts the replayed pre-init notification and completes on the prompt result (${name})`, async () => {
    const f = fixture(session);
    await f.protocol.start(f.send);
    const terminal = frames.findIndex(isPromptResult);
    const queued = frames.findIndex(frame => frame.state === 'queued');
    assert.ok(terminal > frames.findIndex(frame => frame.type === 'result'));
    for (const [index, frame] of frames.entries()) {
      const completed = await f.receive(frame);
      assert.deepEqual(completed, index === terminal ? { exitCode: 0, sessionId: session } : undefined, `frame ${index} ${String(frame.type)}`);
      if (index >= queued && index < terminal) assert.ok(f.steering() > 0, `steering advertised at frame ${index}`);
    }
    assert.equal(f.steering(), -1);
    const delivered = f.frames();
    assert.equal(delivered[0]?.subtype, 'task_notification');
    assert.equal(delivered.filter(frame => frame.type === 'result').length, 2);
  });
}

test('resumed Claude still rejects a pre-init task frame for another or missing session', async () => {
  const notification = wire.sequences.queuedBeforeReplayResult[0]!;
  for (const frame of [{ ...notification, session_id: foreign }, { ...notification, session_id: undefined }]) {
    const f = fixture(session);
    await f.protocol.start(f.send);
    await assert.rejects(f.receive(frame), /session_mismatch/);
  }
  for (const frame of [{ type: 'system', subtype: 'task_started', task_id: 'replayed', task_type: 'local_bash', session_id: session },
    { type: 'system', subtype: 'task_updated', task_id: 'replayed', patch: { status: 'running' }, session_id: session }]) {
    const f = fixture(session);
    await f.protocol.start(f.send);
    await assert.rejects(f.receive(frame), /session_mismatch/);
  }
  const fresh = fixture(undefined);
  await fresh.protocol.start(fresh.send);
  await assert.rejects(fresh.receive(notification), /session_mismatch/);
});

test('resumed Claude rejects init for another session after an accepted replayed notification', async () => {
  const [notification, initialized] = wire.sequences.queuedBeforeReplayResult;
  const f = fixture(session);
  await f.protocol.start(f.send);
  await f.receive(notification!);
  await f.receive(initialized!);
  await assert.rejects(f.receive({ type: 'system', subtype: 'init', session_id: foreign }), /session_mismatch/);
});

test('Claude without command lifecycle skips the replayed result and completes on the prompt result', async () => {
  const f = fixture(session);
  await f.protocol.start(f.send);
  const results: unknown[] = [];
  for (const frame of wire.sequences.replayResultBeforeQueued.filter(frame => frame.type !== 'command_lifecycle')) results.push(await f.receive(frame));
  assert.deepEqual(results.filter(Boolean), [{ exitCode: 0, sessionId: session }]);
});

test('a failed replayed notification turn is forwarded but cannot end the queued prompt', async () => {
  const f = fixture(session);
  await f.protocol.start(f.send);
  const frames = wire.sequences.queuedBeforeReplayResult.map(frame => frame.origin === undefined || frame.type !== 'result' ? frame
    : { ...frame, subtype: 'error_during_execution', is_error: true });
  const completed: unknown[] = [];
  for (const frame of frames) completed.push(await f.receive(frame));
  assert.deepEqual(completed.filter(Boolean), [{ exitCode: 0, sessionId: session }]);
  assert.deepEqual(completed[frames.findIndex(isPromptResult)], { exitCode: 0, sessionId: session });
  assert.deepEqual(f.frames().filter(frame => frame.type === 'result').map(frame => frame.is_error), [true, false]);
});

test('Claude fails the turn when the provider rejects the initial prompt', async () => {
  for (const state of ['cancelled', 'discarded', 'refused']) {
    const f = fixture(session);
    await f.protocol.start(f.send);
    const [notification, initialized, init] = wire.sequences.queuedBeforeReplayResult;
    for (const frame of [notification!, initialized!, init!]) await f.receive(frame);
    assert.deepEqual(await f.receive({ type: 'command_lifecycle', command_uuid: '<initial>', session_id: session, state }),
      { exitCode: 1, error: 'provider_reported_failure', sessionId: session });
    assert.equal(f.steering(), -1);
  }
});

test('a steer queued during the replayed notification turn settles by the existing lifecycle rules', async () => {
  const f = fixture(session);
  await f.protocol.start(f.send);
  const frames = wire.sequences.queuedBeforeReplayResult;
  const replay = frames.findIndex(frame => frame.type === 'result');
  for (const frame of frames.slice(0, replay)) await f.receive(frame);
  const pending = f.steer()!({ idempotencyKey: 'during-replay', prompt: 'follow up', attachments: [] });
  await new Promise(resolve => setImmediate(resolve));
  const uuid = (f.sent.at(-1) as { uuid: string }).uuid;
  const lifecycle = (state: string) => f.receive({ type: 'command_lifecycle', command_uuid: uuid, session_id: session, state });
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: session };
  assert.equal(await lifecycle('queued'), undefined);
  await pending;
  for (const frame of frames.slice(replay, frames.findIndex(isPromptResult) + 1)) assert.equal(await f.receive(frame), undefined);
  assert.equal(await lifecycle('started'), undefined);
  assert.equal(await f.receive(result), undefined);
  assert.deepEqual(await lifecycle('completed'), { exitCode: 0, sessionId: session });
});

test('a task-notification result after the prompt started still completes a fresh turn', async () => {
  const f = fixture(undefined);
  await f.protocol.start(f.send);
  await f.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'codevo-initialize' } });
  await f.receive({ type: 'system', subtype: 'init', session_id: session });
  await f.receive({ type: 'command_lifecycle', command_uuid: '<initial>', session_id: session, state: 'started' });
  await f.receive({ type: 'system', subtype: 'task_started', task_id: 'watch', task_type: 'local_bash', session_id: session });
  assert.equal(await f.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }), undefined);
  await f.receive({ type: 'system', subtype: 'task_notification', task_id: 'watch', status: 'completed', session_id: session });
  assert.deepEqual(await f.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session, origin: { kind: 'task-notification' } }),
    { exitCode: 0, sessionId: session });
});

test('resumed Claude process keeps stdin open past the replayed notification turn', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { executeClaudeInteractive } = await import('../src/infrastructure/execution/claude-interactive.js');
  const cwd = await mkdtemp(join(tmpdir(), 'codevo-claude-replay-'));
  const executable = join(cwd, 'claude');
  await writeFile(executable, `#!${process.execPath}
    const frames = ${JSON.stringify(wire.sequences.queuedBeforeReplayResult)};
    const emit = (frame, uuid) => console.log(JSON.stringify(frame.command_uuid === '<initial>' ? { ...frame, command_uuid: uuid } : frame));
    const replay = frames.findIndex(frame => frame.type === 'result');
    emit(frames[0]);
    process.stdin.on('data', chunk => {
      for (const line of chunk.toString().trim().split('\\n')) {
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') emit(frames[1]);
        if (frame.type !== 'user') continue;
        for (const next of frames.slice(2, replay + 1)) emit(next, frame.uuid);
        setTimeout(() => { for (const next of frames.slice(replay + 1)) emit(next, frame.uuid); }, 50);
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `, { mode: 0o700 });
  let output = '';
  try {
    const signal = new AbortController().signal;
    const result = await executeClaudeInteractive({ executable, args: [], cwd, env: { PATH: process.env.PATH }, timeoutMs: 15_000, signal, prompt: 'Reply with the single word OK.', images: [], request: {
      task: { id: session, runnerId: session, sequence: 2, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
      cwd, signal, attachments: [], resumeSessionId: session, onOutput: async (_channel, text) => { output += text; },
    } });
    assert.deepEqual(result, { exitCode: 0, sessionId: session });
    const results = output.split('\n').filter(Boolean).map(line => JSON.parse(line) as Frame).filter(frame => frame.type === 'result');
    assert.deepEqual(results.map(frame => frame.result), ['', 'OK']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
