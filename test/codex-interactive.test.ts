import { SteeringNotSent } from '../src/domain/steering.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { executeCodexInteractive, createCodexProtocol, type CodexInteractivePlan } from '../src/infrastructure/execution/codex-interactive.js';

const thread = '01998cf0-1111-7111-8111-111111111111';
const turn = 'turn-1';
function fixture(overrides: Partial<ExecutionRequest> = {}) {
  const sent: Record<string, unknown>[] = [];
  let output = '';
  const abort = new AbortController();
  const request: ExecutionRequest = {
    task: { id: 'task', sequence: 1, runnerId: 'runner', provider: 'codex', status: 'running', parts: [{ type: 'text', text: 'Hi' }], createdAt: new Date().toISOString() },
    attachments: [], cwd: '/workspace', signal: abort.signal,
    onOutput: async (_, text) => { output += text; }, ...overrides,
  };
  const plan: CodexInteractivePlan = { executable: 'codex', cwd: '/workspace', env: {}, signal: abort.signal, timeoutMs: 1000, request, prompt: 'literal $(rm -rf nothing)', sandbox: 'workspace-write' };
  const protocol = createCodexProtocol(plan);
  const send = async (value: unknown) => { sent.push(value as Record<string, unknown>); };
  const receive = (frame: Record<string, unknown>) => protocol.receive(frame, send);
  const ready = async () => {
    await protocol.start(send);
    await receive({ id: 1, result: {} });
    await receive({ id: 2, result: { thread: { id: thread } } });
    await receive({ id: 3, result: { turn: { id: turn } } });
  };
  return { protocol, send, sent, receive, ready, abort, output: () => output };
}
const question = (extra: Record<string, unknown> = {}) => ({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, questions: [{ id: 'choice', header: 'Choice', question: 'Pick', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }], ...extra } });

test('app-server handshake preserves launch, resume and image input without shell execution', async () => {
  const f = fixture({ resumeSessionId: thread, attachments: [{ id: 'image', path: '/workspace/my image.png', mediaType: 'image/png' }],
    task: { id: 'task', sequence: 1, runnerId: 'runner', provider: 'codex', status: 'running', parts: [], createdAt: '', launch: { provider: 'codex', model: 'gpt-6-astra', mode: 'readOnly' } } });
  await f.ready();
  assert.deepEqual(f.sent.map(x => x.method), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  const params = f.sent[2]!.params as Record<string, unknown>;
  assert.equal(params.threadId, thread); assert.equal(params.sandbox, 'read-only'); assert.equal(params.model, 'gpt-6-astra');
  const turnParams = f.sent[3]!.params as { input: Array<Record<string, unknown>>; sandboxPolicy: unknown };
  assert.deepEqual(turnParams.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.match(String(turnParams.input[0]!.text), /literal \$\(rm -rf nothing\)/);
  assert.match(String(turnParams.input[0]!.text), /workspace-relative Markdown/);
  assert.deepEqual(turnParams.input[1], { type: 'localImage', path: '/workspace/my image.png' });
});

test('question translates selected labels and custom text into exact appserver response', async () => {
  const f = fixture({ onQuestion: async questions => {
    assert.equal(questions[0]!.allowCustom, true);
    assert.equal(questions[0]!.options[1]!.id, 'option-1');
    return { answers: [{ questionId: 'choice', optionIds: ['option-1'], text: 'With changes' }] };
  } });
  await f.ready(); await f.receive(question());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1))), { id: 'question-1', result: { answers: { choice: { answers: ['Two', 'With changes'] } } } });
  await assert.rejects(f.receive(question()), /duplicate/);
});

test('foreign questions and stale turns fail without publishing a question', async () => {
  let called = false;
  const f = fixture({ onQuestion: async () => { called = true; throw new Error(); } });
  await f.ready();
  await assert.rejects(f.receive(question({ turnId: 'foreign' })), /owner_mismatch/);
  assert.equal(called, false);
});

test('secret, oversized, duplicate questions fail closed', async () => {
  for (const questions of [Array(5).fill({}), [{ id: 'secret', isSecret: true }], [{ id: 'x', question: 'x', options: Array(13).fill({}) }],
    [{ id: 'same', question: 'One?' }, { id: 'same', question: 'Two?' }]]) {
    const f = fixture({ onQuestion: async () => { throw new Error('must-not-call'); } });
    await f.ready(); await assert.rejects(f.receive(question({ questions })), error => !String(error).includes('must-not-call'));
  }
});

test('unknown approval never implicitly authorizes execution', async () => {
  const f = fixture(); await f.ready();
  await f.receive({ id: 88, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn } });
  assert.deepEqual(f.sent.at(-1), { id: 88, error: { code: -32601, message: 'Unsupported server request' } });
});

test('Stop while answering cannot publish an answer', async () => {
  const f = fixture({ onQuestion: async () => {
    f.abort.abort(); return { answers: [{ questionId: 'choice', optionIds: ['option-0'], text: '' }] };
  } });
  await f.ready(); const before = f.sent.length;
  await f.receive(question());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, before);
});

test('assistant, command, usage and completion normalize for existing transcript parser', async () => {
  const f = fixture(); await f.ready();
  const item = (item: unknown, method = 'item/completed') => f.receive({ method, params: { threadId: thread, turnId: turn, item } });
  await item({ id: 'i1', type: 'agentMessage', text: '[Preview](design.html)' });
  await item({ id: 'i2', type: 'commandExecution', command: 'ls', aggregatedOutput: 'done', exitCode: 0 });
  await f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: turn, tokenUsage: { last: { inputTokens: 10, outputTokens: 20 } } } });
  assert.deepEqual(await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } }), { exitCode: 0, sessionId: thread });
  const frames = f.output().trim().split('\n').map(x => JSON.parse(x));
  assert.equal(frames[2].item.type, 'agent_message');
  assert.equal(frames[3].item.aggregated_output, 'done');
  assert.deepEqual(frames.at(-1), { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } });
});

test('long assistant preserves canonical item boundaries for Markdown artifacts', async () => {
  const f = fixture(); await f.ready(); const text = 'ž😀'.repeat(20_000);
  await f.receive({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'a', type: 'agentMessage', text } } });
  const lines = f.output().trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines.slice(2).map(line => JSON.parse(line).item.text).join(''), text);
});

test('foreign resumed session and unexpected reply are rejected', async () => {
  const f = fixture({ resumeSessionId: '01998cf0-2222-7222-8222-222222222222' });
  await f.protocol.start(f.send); await f.receive({ id: 1, result: {} });
  await assert.rejects(f.receive({ id: 2, result: { thread: { id: thread } } }), /session_mismatch/);
  const g = fixture(); await assert.rejects(g.receive({ id: 88, result: {} }), /unexpected/);
});

test('pending question does not block completion and late response is discarded', async () => {
  let answer!: (value: { answers: { questionId: string; optionIds: string[]; text: string }[] }) => void;
  const f = fixture({ onQuestion: () => new Promise(resolve => { answer = resolve; }) });
  await f.ready(); await f.receive(question());
  const before = f.sent.length;
  assert.deepEqual(await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'interrupted' } } }), { exitCode: 1, error: 'provider_reported_failure', sessionId: thread });
  answer({ answers: [{ questionId: 'choice', optionIds: ['option-0'], text: '' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, before);
});

test('provider-resolved pending request fails run and cannot accept stale answer', async () => {
  const f = fixture({ onQuestion: () => new Promise(() => {}) });
  await f.ready(); await f.receive(question());
  assert.deepEqual(await f.receive({ method: 'serverRequest/resolved', params: { threadId: thread, requestId: 'question-1' } }), { exitCode: null, error: 'provider_question_cancelled', sessionId: thread });
});

test('long command output is retained in bounded tool-result segments', async () => {
  const f = fixture(); await f.ready(); const text = '0123456789'.repeat(10000);
  await f.receive({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'c', type: 'commandExecution', command: 'ls', aggregatedOutput: text, exitCode: 0 } } });
  assert.equal(f.output().trim().split('\n').slice(2).map(line => JSON.parse(line).item.aggregated_output).join(''), text);
});


test('real subprocess appserver lifecycle retains spawned children, answers question and reaps provider after completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codevo-codex-interactive-'));
  const executable = join(cwd, 'provider');
  try {
    await writeFile(executable, `#!${process.execPath}
const readline = require('node:readline');
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', line => {
 const frame=JSON.parse(line);
 if(frame.method==='initialize') send({id:frame.id,result:{}});
 if(frame.method==='thread/start') send({id:frame.id,result:{thread:{id:'${thread}'}}});
 if(frame.method==='turn/start') {
   send({id:frame.id,result:{turn:{id:'${turn}'}}});
   send({method:'item/completed',params:{threadId:'${thread}',turnId:'${turn}',item:{id:'spawn',type:'subAgentActivity',kind:'started',agentThreadId:'child',agentPath:'/root/review'}}});
   send({method:'turn/started',params:{threadId:'child',turn:{id:'child-turn'}}});
   send({method:'turn/completed',params:{threadId:'child',turn:{id:'child-turn',status:'completed'}}});
   send(${JSON.stringify(question())});
 }
 if(frame.id==='question-1' && frame.result) {
   if(frame.result.answers.choice.answers[0] !== 'One') process.exit(3);
   send({method:'turn/completed',params:{threadId:'${thread}',turn:{id:'${turn}',status:'completed'}}});
 }
});
setInterval(()=>{},1000);
`, { mode: 0o700 });
    const request: ExecutionRequest = { task: { id: 'task', sequence: 1, runnerId: 'runner', provider: 'codex', status: 'running', parts: [], createdAt: '' },
      cwd, attachments: [], signal: new AbortController().signal, onOutput: async () => {},
      onQuestion: async () => ({ answers: [{ questionId: 'choice', optionIds: ['option-0'], text: '' }] }) };
    const result = await executeCodexInteractive({ executable, cwd, env: {}, signal: request.signal, timeoutMs: 3000, request, prompt: 'test', sandbox: 'workspace-write' });
    assert.deepEqual(result, { exitCode: 0, sessionId: thread });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('turn failure retains actionable provider error', async () => {
  const f = fixture(); await f.ready();
  await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'failed', error: { message: 'Rate limit reached; retry after 30s' } } } });
  assert.match(f.output(), /Rate limit reached; retry after 30s/);
});

test('canonical assistant frame retains cross-boundary artifacts and excludes fenced examples in real collector', async () => {
  const { ProviderArtifactReferences } = await import('../src/domain/artifact-output.js');
  for (const [text, expected] of [
    ['x'.repeat(4090) + '[Preview](design.html)', ['design.html']],
    ['```\n' + 'x'.repeat(4092) + '[Example](example.html)\n```', []],
  ] as const) {
    const collector = new ProviderArtifactReferences('codex');
    const f = fixture({ onOutput: async (channel, value) => { if (channel === 'stdout') collector.push(value); } });
    await f.ready();
    await f.receive({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'message-artifact', type: 'agentMessage', text } } });
    assert.deepEqual(collector.finish(), expected);
    assert.equal(collector.isComplete(), true);
  }
});


test('resume ignores historical usage before new turn ownership without retaining old totals', async () => {
  const f = fixture({ resumeSessionId: thread });
  await f.protocol.start(f.send);
  await f.receive({ id: 1, result: {} });
  const usage = { method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: 'previous-turn', tokenUsage: { last: { inputTokens: 999, outputTokens: 777 } } } };
  await f.receive(usage);
  await f.receive({ id: 2, result: { thread: { id: thread } } });
  await f.receive(usage);
  await f.receive({ id: 3, result: { turn: { id: turn } } });
  await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  const completed = JSON.parse(f.output().trim().split('\n').at(-1)!);
  assert.deepEqual(completed, { type: 'turn.completed' });
});

test('resume still rejects foreign bootstrap usage and stale usage after turn ownership', async () => {
  const f = fixture({ resumeSessionId: thread });
  await f.protocol.start(f.send);
  await f.receive({ id: 1, result: {} });
  await assert.rejects(f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'foreign', turnId: 'old' } }), /owner_mismatch/);
  await f.receive({ id: 2, result: { thread: { id: thread } } });
  await f.receive({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
  await assert.rejects(f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: 'old' } }), /owner_mismatch/);
  await f.receive({ id: 3, result: { turn: { id: turn } } });
  await assert.rejects(f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: 'old' } }), /owner_mismatch/);
});


test('steer waits for exact-turn ACK, preserves images, and rejects after completion', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0] | undefined;
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
  await f.ready();
  let settled = false;
  const pending = steer!({ idempotencyKey: 'message-1', prompt: 'Change direction', attachments: [{ id: 'image', path: '/workspace/a.png', mediaType: 'image/png' }] }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const rpc = f.sent.at(-1)!;
  assert.equal(rpc.method, 'turn/steer');
  assert.deepEqual(rpc.params, { threadId: thread, expectedTurnId: turn, input: [{ type: 'text', text: 'Change direction' }, { type: 'localImage', path: '/workspace/a.png' }] });
  await f.receive({ id: rpc.id, result: { turnId: turn } });
  await pending;
  await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  await assert.rejects(steer!({ idempotencyKey: 'late', prompt: 'late', attachments: [] }), SteeringNotSent);
});

test('tool boundary does not block ACK receive and disposal rejects pending steer', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0] | undefined;
  let pending: Promise<void> | undefined;
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; }, onToolBoundary: async () => {
    pending = steer!({ idempotencyKey: 'boundary', prompt: 'next', attachments: [] });
    await pending;
  } });
  await f.ready();
  await f.receive({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'tool', type: 'commandExecution', command: 'pwd' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending);
  const rejection = assert.rejects(pending, /steering_unavailable/);
  f.protocol.dispose!();
  await rejection;
});

test('pending question refuses steering and provider errors are not accepted', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0];
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; }, onQuestion: () => new Promise(() => {}) });
  await f.ready();
  const pending = steer!({ idempotencyKey: 'error', prompt: 'next', attachments: [] });
  const rejection = assert.rejects(pending, SteeringNotSent);
  await new Promise(resolve => setImmediate(resolve));
  await f.receive({ id: f.sent.at(-1)!.id, error: { code: -1, message: 'busy' } });
  await rejection;
  await f.receive(question());
  await assert.rejects(steer!({ idempotencyKey: 'question', prompt: 'next', attachments: [] }), SteeringNotSent);
  f.protocol.dispose!();
});

test('Codex child lifecycle belongs to linked child and never finishes the root turn', async () => {
 const f=fixture();await f.ready();
 await f.receive({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'collab',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}}}}});
 assert.equal(await f.receive({method:'turn/started',params:{threadId:'child',turn:{id:'child-turn'}}}),undefined);
 assert.equal(await f.receive({method:'turn/completed',params:{threadId:'child',turn:{id:'child-turn',status:'completed'}}}),undefined);
 const frames=f.output().trim().split('\n').map(value=>JSON.parse(value) as Record<string,unknown>);
 assert.ok(frames.some(frame=>frame.t==='subagentTurnCompleted'&&frame.agentThreadId==='child'));
 await assert.rejects(f.receive({method:'turn/completed',params:{threadId:'foreign',turn:{id:'foreign-turn',status:'completed'}}}),/owner_mismatch/);
 assert.deepEqual(await f.receive({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}}),{exitCode:0,sessionId:thread});
});

test('Codex late child completion cannot complete its newer active turn', async () => {
 const f=fixture();await f.ready();
 await f.receive({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'collab',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child']}}});
 const start=(id:string)=>f.receive({method:'turn/started',params:{threadId:'child',turn:{id}}});
 const complete=(id:string)=>f.receive({method:'turn/completed',params:{threadId:'child',turn:{id,status:'completed'}}});
 await start('a');await complete('a');await start('b');
 const before=f.output();await start('a');await complete('a');await complete('unseen');await start('unseen');assert.equal(f.output(),before);
 await complete('b');assert.equal(f.output().split('subagentTurnCompleted').length-1,2);
});


test('native subAgentActivity links child before telemetry and preserves root completion', async () => {
  const f = fixture(); await f.ready();
  await f.receive({ method: 'item/completed', params: { threadId: thread, turnId: turn,
    item: { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/review' } } });
  await f.receive({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  await f.receive({ method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn',
    item: { id: 'child-output', type: 'agentMessage', text: 'Private child output' } } });
  assert.equal(await f.receive({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } }), undefined);
  assert.equal(f.output().includes('Private child output'), false);
  const activity = f.output().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(activity.some(event => event.t === 'subagent' && event.kind === 'started' && event.agentThreadId === 'child'));
  assert.ok(activity.some(event => event.t === 'subagentTurnCompleted' && event.agentThreadId === 'child'));
  assert.deepEqual(await f.receive({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } }), { exitCode: 0, sessionId: thread });
});


test('native subagent linkage rejects foreign parents, invalid identity, unknown kinds and overflow', async () => {
  const f = fixture(); await f.ready();
  const activity = (overrides: Record<string, unknown> = {}, parent = thread) => ({ method: 'item/started', params: {
    threadId: parent, turnId: turn, item: { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', ...overrides },
  } });
  await assert.rejects(f.receive(activity({}, 'foreign')), /owner_mismatch/);
  await assert.rejects(f.receive(activity({ agentThreadId: thread })), /owner_mismatch/);
  await assert.rejects(f.receive(activity({ agentThreadId: '' })), /owner_invalid/);
  await assert.rejects(f.receive(activity({ kind: 'unknown' })), /subagent_kind_invalid/);
  await assert.rejects(f.receive(activity({ kind: ['started'] })), /subagent_kind_invalid/);
  await assert.rejects(f.receive({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'foreign-turn' } } }), /owner_mismatch/);
  assert.equal(f.output().includes('subagent'), false);
  for (let i = 0; i < 256; i++) await f.receive(activity({ agentThreadId: `child-${i}` }));
  await assert.rejects(f.receive(activity({ agentThreadId: 'overflow' })), /child_limit/);
  await f.receive(activity({ agentThreadId: 'child-0', kind: 'interacted', agentPath: '🧪'.repeat(2000) }));
  const last = JSON.parse(f.output().trim().split('\n').at(-1)!);
  assert.equal(last.clipped, true);
  assert.equal(Buffer.byteLength(last.agentPath), 256);
  assert.equal(last.agentPath, '🧪'.repeat(64));
});

test('Codex steering references text attachments without localImage input', async () => {
  let steer: Parameters<NonNullable<ExecutionRequest['onSteeringReady']>>[0] | undefined;
  const f = fixture({ onSteeringReady: handler => { if (handler) steer = handler; } });
  await f.ready();
  const pending = steer!({ idempotencyKey: 'text-file', prompt: 'Read this', attachments: [{ id: 'text', path: '/workspace/pasted.txt', mediaType: 'text/plain' }] });
  await new Promise(resolve => setImmediate(resolve));
  const rpc = f.sent.at(-1)!;
  const input = (rpc.params as { input: { type: string; text: string }[] }).input;
  assert.equal(input.length, 1);
  assert.equal(input[0]!.type, 'text');
  assert.ok(input[0]!.text.includes('"/workspace/pasted.txt"'));
  await f.receive({ id: rpc.id, result: { turnId: turn } });
  await pending;
});
