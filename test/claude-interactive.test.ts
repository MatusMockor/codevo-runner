import { SteeringNotSent } from '../src/domain/steering.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeProtocol, parseClaudeQuestions } from '../src/infrastructure/execution/claude-interactive.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
const session = '01998cf0-1111-7111-8111-111111111111';
const input = { questions: [{ header: 'Database', question: 'Which database?', multiSelect: false,
  options: [{ label: 'SQLite', description: 'Local' }, { label: 'Postgres', description: 'Remote' }] }] };
function fixture(overrides: Partial<ExecutionRequest> = {}) {
  const sent: unknown[] = [];
  const request: ExecutionRequest = { task: { id: session, runnerId: session, sequence: 1, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
    cwd: '/tmp', signal: new AbortController().signal, attachments: [], onOutput: async () => {},
    onQuestion: async questions => ({ answers: [{ questionId: questions[0]!.id, optionIds: ['o0'], text: 'with backups' }] }), ...overrides };
  return { sent, send: async (value: unknown) => { sent.push(value); }, protocol: createClaudeProtocol({ executable: 'claude', args: [], cwd: '/tmp', env: {}, signal: request.signal, timeoutMs: 1000, request, prompt: 'Hello', images: [] }) };
}
test('Claude waits initialize, maps structured AskUserQuestion answer to original question', async () => {
  const f = fixture();
  await f.protocol.start(f.send);
  assert.equal(f.sent.length, 1);
  await f.protocol.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'codevo-initialize', response: {} } }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  await f.protocol.receive({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1', input } }, f.send);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent[2])), { type: 'control_response', response: { subtype: 'success', request_id: 'ask-1', response: {
    behavior: 'allow', updatedInput: { ...input, answers: { 'Which database?': 'SQLite, with backups' } }, toolUseID: 'tool-1' } } });
  assert.deepEqual(await f.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, f.send), { exitCode: 0, sessionId: session });
  await assert.rejects(f.protocol.receive({ type: 'control_request', request_id: 'ask-1', request: {} }, f.send));
});
test('Claude refuses malformed options and mismatched terminal session', async () => {
  assert.throws(() => parseClaudeQuestions({ questions: [{ ...input.questions[0], options: Array(13).fill({ label: 'x' }) }] }));
  const f = fixture();
  await assert.rejects(f.protocol.receive({ type: 'result', session_id: session }, f.send));
});
test('Claude rejects duplicate prompt and option label mappings', () => {
  assert.throws(() => parseClaudeQuestions({ questions: [input.questions[0], input.questions[0]] }));
  assert.throws(() => parseClaudeQuestions({ questions: [{ ...input.questions[0], options: [input.questions[0]!.options[0], input.questions[0]!.options[0]] }] }));
});

test('Claude retains foreground success until real background work and delayed answer finish', async () => {
  const f = fixture();
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  const success = { type: 'result', subtype: 'success', is_error: false, session_id: session };
  await f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'watch-1', task_type: 'local_bash', session_id: session }, f.send);
  assert.equal(await f.protocol.receive(success, f.send), undefined);
  await f.protocol.receive({ type: 'system', subtype: 'task_notification', task_id: 'watch-1', status: 'completed', session_id: session }, f.send);
  // A duplicate start or late progress cannot revive completed work.
  await f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'watch-1', session_id: session }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'task_progress', task_id: 'watch-1', session_id: session }, f.send);
  assert.equal(await f.protocol.receive({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pipeline completed.' }] } }, f.send), undefined);
  assert.deepEqual(await f.protocol.receive(success, f.send), { exitCode: 0, sessionId: session });
});

test('Claude task patches settle live work while foreign sessions fail closed', async () => {
  const f = fixture();
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  await assert.rejects(f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'x', session_id: 'foreign' }, f.send), /session_mismatch/);
  await f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'x' }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'task_updated', task_id: 'x', patch: { status: 'killed' } }, f.send);
  assert.deepEqual(await f.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, f.send), { exitCode: 0, sessionId: session });
});

test('Claude error results stay terminal with background work; failed task awaits final result', async () => {
  const f = fixture();
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'x' }, f.send);
  assert.deepEqual(await f.protocol.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session }, f.send), {
    exitCode: 1, sessionId: session, error: 'provider_reported_failure',
  });
  const second = fixture();
  await second.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, second.send);
  await second.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'x' }, second.send);
  assert.equal(await second.protocol.receive({ type: 'system', subtype: 'task_notification', task_id: 'x', status: 'failed' }, second.send), undefined);
  assert.deepEqual(await second.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, second.send), { exitCode: 0, sessionId: session });
});

test('Claude retains paused work because it can resume before the delayed final result', async () => {
  const f = fixture();
  const success = { type: 'result', subtype: 'success', is_error: false, session_id: session };
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'monitor' }, f.send);
  await f.protocol.receive({ type: 'system', subtype: 'task_updated', task_id: 'monitor', patch: { status: 'paused' } }, f.send);
  assert.equal(await f.protocol.receive(success, f.send), undefined);
  await f.protocol.receive({ type: 'system', subtype: 'task_updated', task_id: 'monitor', patch: { status: 'running' } }, f.send);
  assert.equal(await f.protocol.receive(success, f.send), undefined);
  await f.protocol.receive({ type: 'system', subtype: 'task_updated', task_id: 'monitor', patch: { status: 'completed' } }, f.send);
  assert.deepEqual(await f.protocol.receive(success, f.send), { exitCode: 0, sessionId: session });
});


async function steeringReady(f: ReturnType<typeof fixture>) {
  await f.protocol.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'codevo-initialize' } }, f.send);
  const initial = f.sent.at(-1) as { uuid: string };
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  await f.protocol.receive({ type: 'command_lifecycle', command_uuid: initial.uuid, session_id: session, state: 'started' }, f.send);
}
async function acknowledgeSteer(f: ReturnType<typeof fixture>) {
  await new Promise(resolve => setImmediate(resolve));
  const frame = f.sent.at(-1) as { uuid: string };
  await f.protocol.receive({ type: 'command_lifecycle', command_uuid: frame.uuid, session_id: session, state: 'started' }, f.send);
  return frame.uuid;
}

test('Claude steering preserves active session and rejects completed ownership', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0] | undefined;
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
  await steeringReady(f);
  const pending = steer!({ idempotencyKey: 'now', prompt: 'Change direction', attachments: [] });
  const uuid = await acknowledgeSteer(f); await pending;
  assert.deepEqual(f.sent.at(-1), { type: 'user', uuid, session_id: session, message: { role: 'user', content: [{ type: 'text', text: 'Change direction' }] } });
  await f.protocol.receive({ type: 'command_lifecycle', command_uuid: uuid, session_id: session, state: 'completed' }, f.send);
  await f.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, f.send);
  await assert.rejects(steer!({ idempotencyKey: 'late', prompt: 'late', attachments: [] }), SteeringNotSent);
});

test('Claude steering reads bounded staged image bytes and rejects symlinks', async () => {
  const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'claude-steer-'));
  try {
    const path = join(root, 'image.png');
    await writeFile(path, Buffer.from('image-bytes'));
    await symlink(path, join(root, 'link.png'));
    let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
    const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
    await steeringReady(f);
    const pending = steer!({ idempotencyKey: 'image', prompt: '', attachments: [{ id: 'image', path, mediaType: 'image/png' }] });
    // Filesystem reads precede the actual stdin write.
    while (!(f.sent.at(-1) as { session_id?: string }).session_id) await new Promise(resolve => setImmediate(resolve));
    await acknowledgeSteer(f); await pending;
    assert.match(JSON.stringify(f.sent.at(-1)), /aW1hZ2UtYnl0ZXM=/);
    await assert.rejects(steer!({ idempotencyKey: 'link', prompt: '', attachments: [{ id: 'link', path: join(root, 'link.png'), mediaType: 'image/png' }] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('Claude lifecycle protects queued steer from old result and completes in either event order', async () => {
  for (const completedFirst of [false, true]) {
    let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
    const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
    await steeringReady(f);
    const pending = steer!({ idempotencyKey: 'race', prompt: 'followup', attachments: [] });
    await new Promise(resolve => setImmediate(resolve));
    const uuid = (f.sent.at(-1) as { uuid: string }).uuid;
    const lifecycle = (state: string) => f.protocol.receive({ type: 'command_lifecycle', command_uuid: uuid, session_id: session, state }, f.send);
    const result = () => f.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, f.send);
    await lifecycle('queued'); await pending;
    assert.equal(await result(), undefined);
    await lifecycle('started');
    assert.equal(await (completedFirst ? lifecycle('completed') : result()), undefined);
    assert.deepEqual(await (completedFirst ? result() : lifecycle('completed')), { exitCode: 0, sessionId: session });
  }
});

test('older Claude without correlated lifecycle cannot advertise live steering', async () => {
  let advertised = false;
  const f = fixture({ onSteeringReady: handler => { advertised ||= !!handler; } });
  await f.protocol.receive({ type: 'system', subtype: 'init', session_id: session }, f.send);
  assert.equal(advertised, false);
});

test('Claude cancellation after queue acceptance fails the task rather than losing accepted input', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
  await steeringReady(f);
  const pending = steer!({ idempotencyKey: 'cancel', prompt: 'followup', attachments: [] });
  const uuid = await acknowledgeSteer(f); await pending;
  assert.deepEqual(await f.protocol.receive({ type: 'command_lifecycle', command_uuid: uuid, session_id: session, state: 'cancelled' }, f.send), { exitCode: 1, error: 'provider_steering_failed', sessionId: session });
});

test('Claude refused unaccepted followup releases stored foreground result without hanging', async () => {
 for (const state of ['refused', 'discarded', 'cancelled']) {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
  const f = fixture({onSteeringReady:handler=>{if(handler)steer=handler;}});
  await steeringReady(f);
  const pending=steer!({idempotencyKey:'refused',prompt:'follow up',attachments:[]});
  const rejected=assert.rejects(pending,SteeringNotSent);
  await new Promise(resolve=>setImmediate(resolve));
  const uuid=(f.sent.at(-1) as {uuid:string}).uuid;
  assert.equal(await f.protocol.receive({type:'result',subtype:'success',is_error:false,session_id:session},f.send),undefined);
  assert.deepEqual(await f.protocol.receive({type:'command_lifecycle',command_uuid:uuid,session_id:session,state},f.send),{exitCode:0,sessionId:session});
  await rejected;
 }
});

test('Claude steering references UTF-8 text as file, rejects invalid bytes without delivery', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'claude-text-steer-'));
  try {
    const path = join(root, 'pasted.txt');
    await writeFile(path, 'User pasted content');
    let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
    const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
    await steeringReady(f);
    const pending = steer!({ idempotencyKey: 'text', prompt: '', attachments: [{ id: 'text', path, mediaType: 'text/plain' }] });
    while (!(f.sent.at(-1) as { session_id?: string }).session_id) await new Promise(resolve => setImmediate(resolve));
    await acknowledgeSteer(f); await pending;
    const sent = f.sent.at(-1) as { message: { content: { type: string; text: string }[] } };
    assert.equal(sent.message.content.length, 1);
    assert.equal(sent.message.content[0]!.type, 'text');
    assert.ok(sent.message.content[0]!.text.includes(JSON.stringify(path)));
    await f.protocol.receive({ type: 'control_request', request_id: 'read-steered-text', request: {
      subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: path },
    } }, f.send);
    const allowed = f.sent.at(-1) as { response: { response: { behavior: string } } };
    assert.equal(allowed.response.response.behavior, 'allow');
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(steer!({ idempotencyKey: 'bad-text', prompt: '', attachments: [{ id: 'text', path, mediaType: 'text/plain' }] }), SteeringNotSent);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('Claude permits Read only for its exact staged text paths', async () => {
  const path = '/private/runner/execution-inputs/task/pasted.txt';
  const f = fixture({ attachments: [{ id: 'text', path, mediaType: 'text/plain' }] });
  await steeringReady(f);
  for (const [index, file] of [path, '/private/runner/token', path + '/../../token'].entries()) {
    await f.protocol.receive({ type: 'control_request', request_id: `read-${index}`, request: {
      subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: file },
    } }, f.send);
    const reply = f.sent.at(-1) as { response: { response: { behavior: string } } };
    assert.equal(reply.response.response.behavior, index === 0 ? 'allow' : 'deny');
  }
});
