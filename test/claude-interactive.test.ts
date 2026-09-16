import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeProtocol, parseClaudeQuestions } from '../src/infrastructure/execution/claude-interactive.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
const session = '01998cf0-1111-7111-8111-111111111111';
const input = { questions: [{ header: 'Database', question: 'Which database?', multiSelect: false,
  options: [{ label: 'SQLite', description: 'Local' }, { label: 'Postgres', description: 'Remote' }] }] };
function fixture() {
  const sent: unknown[] = [];
  const request: ExecutionRequest = { task: { id: session, runnerId: session, sequence: 1, provider: 'claude', status: 'running', parts: [], createdAt: new Date().toISOString() },
    cwd: '/tmp', signal: new AbortController().signal, attachments: [], onOutput: async () => {},
    onQuestion: async questions => ({ answers: [{ questionId: questions[0]!.id, optionIds: ['o0'], text: 'with backups' }] }) };
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
