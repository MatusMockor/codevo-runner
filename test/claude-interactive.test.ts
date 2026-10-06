import { SteeringNotSent } from '../src/domain/steering.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeProtocol, parseClaudeQuestions } from '../src/infrastructure/execution/claude-interactive.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import type { AgentApprovalInput, AgentApprovalOutcome } from '../src/domain/approvals.js';
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

type ApprovalCall = Readonly<{
  input: AgentApprovalInput; signal: AbortSignal;
  resolve(outcome: AgentApprovalOutcome): void; reject(error: Error): void;
}>;
function approvalFixture(overrides: Partial<ExecutionRequest> = {}) {
  const calls: ApprovalCall[] = [];
  const f = fixture({ onApproval: (input, signal) => new Promise<AgentApprovalOutcome>((resolve, reject) => { calls.push({ input, signal, resolve, reject }); }), ...overrides });
  return { ...f, calls };
}
const permission = (id: string, tool: string, input: unknown, extra: Record<string, unknown> = {}) => ({ type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: `tool-${id}`, input, ...extra } });
const reply = (id: string, response: unknown) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
const settle = () => new Promise(resolve => setImmediate(resolve));
const bash = { command: 'npm test', description: 'Run the test suite' };
const legacyDeny = 'Interactive permission approval is not supported by this runner.';
const unanswered = 'No approval decision was received, so this action was not allowed.';
const unansweredPlan = 'No decision on the plan was received. Plan mode stays active; the plan was neither approved nor rejected.';
const allowRules = (...rules: unknown[]) => [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules }];
const sessionFact = (input: AgentApprovalInput) => input.facts.find(fact => fact.label === 'Session approval covers')?.value;

test('Claude without an approval callback keeps the byte-identical legacy denial', async () => {
  const f = fixture();
  await steeringReady(f);
  await f.protocol.receive(permission('bash-1', 'Bash', bash), f.send);
  assert.equal(JSON.stringify(f.sent.at(-1)), '{"type":"control_response","response":{"subtype":"success","request_id":"bash-1","response":'
    + '{"behavior":"deny","message":"Interactive permission approval is not supported by this runner.","toolUseID":"tool-bash-1"}}}');
  assert.deepEqual(await f.protocol.receive({ type: 'control_cancel_request', request_id: 'bash-1' }, f.send), { exitCode: null, error: 'provider_question_cancelled' });
  const waiting = fixture({ onQuestion: () => new Promise(() => {}) });
  await steeringReady(waiting);
  await waiting.protocol.receive({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }, waiting.send);
  await assert.rejects(waiting.protocol.receive(permission('bash-2', 'Bash', bash), waiting.send), /duplicate_or_concurrent_question/);
  const limited = fixture();
  await steeringReady(limited);
  for (let index = 0; index < 128; index++) await limited.protocol.receive(permission(`bash-${index}`, 'Bash', bash), limited.send);
  await assert.rejects(limited.protocol.receive(permission('bash-128', 'Bash', bash), limited.send), /duplicate_or_concurrent_question/);
});

test('Claude maps permission requests to approvals and each decision to its control response', async () => {
  const f = approvalFixture();
  await steeringReady(f);
  const before = f.sent.length;
  const suggestions = [
    { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [
      { toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }, { toolName: 'Ba sh' }] },
    { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] },
    { type: 'setMode', mode: 'acceptEdits' },
  ];
  await f.protocol.receive(permission('p1', 'Bash', bash, { permission_suggestions: suggestions, blocked_path: '/etc', decision_reason: 'Not allowlisted', description: 'Needs a shell' }), f.send);
  assert.equal(f.sent.length, before);
  assert.deepEqual(f.calls[0]!.input, { kind: 'command', title: 'Run a command?', detail: 'npm test', detailTruncated: false,
    facts: [{ label: 'Tool', value: 'Bash' }, { label: 'Purpose', value: 'Run the test suite' }, { label: 'Blocked path', value: '/etc' },
      { label: 'Reason', value: 'Not allowlisted' }, { label: 'Details', value: 'Needs a shell' }, { label: 'Session approval covers', value: 'Bash(npm test:*)' }],
    decisions: ['allowOnce', 'allowForSession', 'deny'] });
  f.calls[0]!.resolve('allowForSession');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p1', { behavior: 'allow', updatedInput: bash, toolUseID: 'tool-p1',
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] }));
  await f.protocol.receive(permission('p2', 'Bash', bash), f.send);
  assert.deepEqual(f.calls[1]!.input.decisions, ['allowOnce', 'deny']);
  f.calls[1]!.resolve('allowOnce');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p2', { behavior: 'allow', updatedInput: bash, toolUseID: 'tool-p2' }));
  const write = { file_path: '/workspace/a.txt', content: 'new body' };
  await f.protocol.receive(permission('p3', 'Write', write, { title: 'Claude wants to write a.txt' }), f.send);
  assert.deepEqual(f.calls[2]!.input, { kind: 'fileChange', title: 'Claude wants to write a.txt', detail: 'new body', detailTruncated: false,
    facts: [{ label: 'Tool', value: 'Write' }, { label: 'File', value: '/workspace/a.txt' }], decisions: ['allowOnce', 'deny'] });
  f.calls[2]!.resolve('deny');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p3', { behavior: 'deny', message: 'The user denied this action.' }));
  await f.protocol.receive(permission('p4', 'ExitPlanMode', { plan: '1. Ship it' }, { permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'ExitPlanMode' }] }] }), f.send);
  assert.deepEqual(f.calls[3]!.input, { kind: 'plan', title: 'Approve the plan?', detail: '1. Ship it', detailTruncated: false,
    facts: [{ label: 'Tool', value: 'ExitPlanMode' }], decisions: ['allowOnce', 'deny'] });
  f.calls[3]!.resolve('deny');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p4', { behavior: 'deny', message: 'The user wants to keep planning. Stay in plan mode and refine the plan.' }));
  const issue = { title: 'Bug', labels: ['a'] };
  await f.protocol.receive(permission('p5', 'mcp__github__create_issue', issue, { title: '  ' }), f.send);
  assert.deepEqual(f.calls[4]!.input, { kind: 'tool', title: 'Allow mcp__github__create_issue?', detail: JSON.stringify(issue, null, 2), detailTruncated: false,
    facts: [{ label: 'Tool', value: 'mcp__github__create_issue' }], decisions: ['allowOnce', 'deny'] });
  f.calls[4]!.reject(new Error('busy'));
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p5', { behavior: 'deny', message: unanswered }));
  await f.protocol.receive(permission('p6', 'MultiEdit', { file_path: '/workspace/b.txt', edits: [{ new_string: 'one' }, { old_string: 'x' }, { new_string: 'two' }] }), f.send);
  assert.equal(f.calls[5]!.input.title, 'Allow MultiEdit to change a file?');
  assert.equal(f.calls[5]!.input.detail, 'one\n---\ntwo');
  await f.protocol.receive(permission('p7', 'Bash', { command: 'é'.repeat(9000) }), f.send);
  assert.equal(f.calls[6]!.input.detailTruncated, true);
  assert.equal(Buffer.byteLength(f.calls[6]!.input.detail), 16 * 1024);
  f.protocol.dispose!();
  assert.deepEqual(f.calls.slice(5).map(call => call.signal.aborted), [true, true]);
});

test('Claude concurrent approvals settle independently in either order beside a pending question', async () => {
  for (const order of [[0, 1], [1, 0]] as const) {
    const f = approvalFixture({ onQuestion: () => new Promise(() => {}) });
    await steeringReady(f);
    await f.protocol.receive({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }, f.send);
    await f.protocol.receive(permission('a', 'Bash', bash), f.send);
    await f.protocol.receive(permission('b', 'Bash', { command: 'ls' }), f.send);
    const before = f.sent.length;
    f.calls[order[0]]!.resolve('allowOnce');
    await settle();
    assert.equal(f.sent.length, before + 1);
    assert.equal((f.sent.at(-1) as { response: { request_id: string } }).response.request_id, order[0] === 0 ? 'a' : 'b');
    assert.equal(f.calls[order[1]]!.signal.aborted, false);
    f.calls[order[1]]!.resolve('deny');
    await settle();
    assert.deepEqual(f.sent.at(-1), reply(order[1] === 0 ? 'a' : 'b', { behavior: 'deny', message: 'The user denied this action.' }));
    f.calls[order[0]]!.resolve('deny');
    await settle();
    assert.equal(f.sent.length, before + 2);
    await assert.rejects(f.protocol.receive({ type: 'control_request', request_id: 'ask-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }, f.send), /duplicate_or_concurrent_question/);
  }
});

test('Claude cancel requests abort only their pending approval and unknown ids keep failing the run', async () => {
  const f = approvalFixture();
  await steeringReady(f);
  await f.protocol.receive(permission('p1', 'Bash', bash), f.send);
  await f.protocol.receive(permission('p2', 'Bash', bash), f.send);
  const before = f.sent.length;
  assert.equal(await f.protocol.receive({ type: 'control_cancel_request', request_id: 'p1' }, f.send), undefined);
  assert.deepEqual(f.calls.map(call => call.signal.aborted), [true, false]);
  f.calls[0]!.resolve('allowOnce');
  await settle();
  assert.equal(f.sent.length, before);
  assert.equal(await f.protocol.receive({ type: 'control_cancel_request', request_id: 'p1' }, f.send), undefined);
  f.calls[1]!.resolve('allowOnce');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('p2', { behavior: 'allow', updatedInput: bash, toolUseID: 'tool-p2' }));
  assert.deepEqual(await f.protocol.receive({ type: 'control_cancel_request', request_id: 'never-seen' }, f.send), { exitCode: null, error: 'provider_question_cancelled' });
  const asking = approvalFixture({ onQuestion: () => new Promise(() => {}) });
  await steeringReady(asking);
  await asking.protocol.receive({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }, asking.send);
  assert.deepEqual(await asking.protocol.receive({ type: 'control_cancel_request', request_id: 'ask-1' }, asking.send), { exitCode: null, error: 'provider_question_cancelled' });
});

test('Claude terminal result cancels a pending approval and a late decision sends nothing', async () => {
  const f = approvalFixture();
  await steeringReady(f);
  await f.protocol.receive(permission('p1', 'Bash', bash), f.send);
  const before = f.sent.length;
  assert.deepEqual(await f.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, f.send), { exitCode: 0, sessionId: session });
  assert.equal(f.calls[0]!.signal.aborted, true);
  f.calls[0]!.resolve('allowOnce');
  await settle();
  assert.equal(f.sent.length, before);
  const background = approvalFixture();
  await steeringReady(background);
  await background.protocol.receive({ type: 'system', subtype: 'task_started', task_id: 'agent-1', session_id: session }, background.send);
  await background.protocol.receive(permission('p1', 'Bash', bash), background.send);
  assert.equal(await background.protocol.receive({ type: 'result', subtype: 'success', is_error: false, session_id: session }, background.send), undefined);
  assert.equal(background.calls[0]!.signal.aborted, false);
  background.calls[0]!.resolve('allowOnce');
  await settle();
  assert.deepEqual(background.sent.at(-1), reply('p1', { behavior: 'allow', updatedInput: bash, toolUseID: 'tool-p1' }));
});

test('Claude steering is refused while an approval is pending', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0] | undefined;
  const f = approvalFixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
  await steeringReady(f);
  await f.protocol.receive(permission('p1', 'Bash', bash), f.send);
  const before = f.sent.length;
  await assert.rejects(steer!({ idempotencyKey: 'blocked', prompt: 'Change direction', attachments: [] }), SteeringNotSent);
  assert.equal(f.sent.length, before);
  f.calls[0]!.resolve('deny');
  await settle();
  const accepted = steer!({ idempotencyKey: 'free', prompt: 'Change direction', attachments: [] });
  await acknowledgeSteer(f);
  await accepted;
});

test('Claude denies malformed permission requests without registering an approval', async () => {
  const f = approvalFixture({ attachments: [{ id: 'text', path: '/private/staged.txt', mediaType: 'text/plain' }] });
  await steeringReady(f);
  const requests = [
    permission('long', 'T'.repeat(129), {}),
    permission('empty', '', {}),
    permission('bash', 'Bash', { description: 'no command' }),
    permission('array', 'WebFetch', ['https://example.invalid']),
    { type: 'control_request', request_id: 'hook', request: { subtype: 'hook_callback', tool_use_id: 'tool-hook' } },
  ];
  for (const request of requests) {
    await f.protocol.receive(request, f.send);
    assert.deepEqual(f.sent.at(-1), reply(request.request_id, { behavior: 'deny', message: legacyDeny, toolUseID: `tool-${request.request_id}` }));
  }
  await f.protocol.receive(permission('staged', 'Read', { file_path: '/private/staged.txt' }), f.send);
  assert.deepEqual(f.sent.at(-1), reply('staged', { behavior: 'allow', updatedInput: { file_path: '/private/staged.txt' }, toolUseID: 'tool-staged' }));
  assert.equal(f.calls.length, 0);
  await f.protocol.receive(permission('other', 'Read', { file_path: '/private/token' }), f.send);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.input.kind, 'tool');
  for (let index = 0; index < 200; index++) await f.protocol.receive(permission(`many-${index}`, 'T'.repeat(129), {}), f.send);
  assert.equal(f.calls.length, 1);
});

test('Claude reports a missing decision truthfully instead of as a user denial', async () => {
  const f = approvalFixture();
  await steeringReady(f);
  await f.protocol.receive(permission('timed', 'Bash', bash), f.send);
  f.calls[0]!.resolve('unanswered');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('timed', { behavior: 'deny', message: unanswered }));
  await f.protocol.receive(permission('plan-timed', 'ExitPlanMode', { plan: '1. Ship it' }), f.send);
  f.calls[1]!.resolve('unanswered');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('plan-timed', { behavior: 'deny', message: unansweredPlan }));
  await f.protocol.receive(permission('plan-failed', 'ExitPlanMode', { plan: '1. Ship it' }), f.send);
  f.calls[2]!.reject(new Error('quota_exceeded'));
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('plan-failed', { behavior: 'deny', message: unansweredPlan }));
  await f.protocol.receive(permission('plan-denied', 'ExitPlanMode', { plan: '1. Ship it' }), f.send);
  f.calls[3]!.resolve('deny');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('plan-denied', { behavior: 'deny', message: 'The user wants to keep planning. Stay in plan mode and refine the plan.' }));
});

test('Claude session approval sends exactly the rules it listed and is withheld when any rule cannot be shown', async () => {
  const f = approvalFixture();
  await steeringReady(f);
  const shown = [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bash', ruleContent: 'x'.repeat(1000) }, { toolName: 'Bash' }];
  await f.protocol.receive(permission('fits', 'Bash', bash, { permission_suggestions: [...allowRules(shown[0], { toolName: 'Read' }), ...allowRules(shown[1], shown[2])] }), f.send);
  assert.deepEqual(f.calls[0]!.input.decisions, ['allowOnce', 'allowForSession', 'deny']);
  assert.equal(sessionFact(f.calls[0]!.input), `Bash(npm test:*), Bash(${'x'.repeat(1000)}), all Bash commands`);
  f.calls[0]!.resolve('allowForSession');
  await settle();
  assert.deepEqual(f.sent.at(-1), reply('fits', { behavior: 'allow', updatedInput: bash, toolUseID: 'tool-fits',
    updatedPermissions: [{ type: 'addRules', rules: shown, behavior: 'allow', destination: 'session' }] }));
  const long = Array.from({ length: 16 }, (_, index) => ({ toolName: 'Bash', ruleContent: `${index}`.padEnd(1024, 'y') }));
  const withheld = [
    allowRules(...long),
    allowRules(long[0], long[1]),
    allowRules(shown[0], { toolName: 'Bash', ruleContent: 'x'.repeat(1025) }),
    allowRules(shown[0], { toolName: 'Bash', ruleContent: 7 }),
    allowRules(shown[0], { toolName: 'Bash', ruleContent: 'ls\nrm -rf /' }),
    allowRules({ toolName: 'Bash', ruleContent: 'a\u2028b' }),
    allowRules(...Array.from({ length: 17 }, () => shown[0])),
    Array.from({ length: 17 }, () => allowRules(shown[0])[0]),
    [...allowRules(...Array.from({ length: 9 }, () => shown[0])), ...allowRules(...Array.from({ length: 8 }, () => shown[0]))],
    allowRules({ toolName: 'Read' }),
    'Bash',
  ];
  for (const [index, suggestions] of withheld.entries()) {
    await f.protocol.receive(permission(`withheld-${index}`, 'Bash', bash, { permission_suggestions: suggestions }), f.send);
    const call = f.calls.at(-1)!;
    assert.deepEqual(call.input.decisions, ['allowOnce', 'deny'], `case ${index}`);
    assert.equal(sessionFact(call.input), undefined);
    call.resolve('allowForSession');
    await settle();
    assert.deepEqual(f.sent.at(-1), reply(`withheld-${index}`, { behavior: 'deny', message: unanswered }));
  }
  assert.equal(f.calls.length, 1 + withheld.length);
  const boundary = [{ toolName: 'Bash', ruleContent: 'a'.repeat(1016) }, { toolName: 'Bash', ruleContent: 'b'.repeat(1018) }];
  await f.protocol.receive(permission('boundary', 'Bash', bash, { permission_suggestions: allowRules(...boundary) }), f.send);
  assert.equal(Buffer.byteLength(sessionFact(f.calls.at(-1)!.input) ?? ''), 2048);
  assert.deepEqual(f.calls.at(-1)!.input.decisions, ['allowOnce', 'allowForSession', 'deny']);
});
