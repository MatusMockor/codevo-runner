import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderOutputParser } from '../src/domain/provider-output.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
function events(provider: 'codex' | 'claude', id = sessionId) {
  return provider === 'codex'
    ? [{ type: 'thread.started', thread_id: id }, { type: 'turn.completed', usage: {} }]
    : [{ type: 'system', subtype: 'init', session_id: id }, { type: 'result', subtype: 'success', is_error: false, session_id: id }];
}
for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} parses split frames and an unterminated final line`, () => {
    const parser = new ProviderOutputParser(provider, sessionId);
    const text = events(provider).map(event => JSON.stringify(event)).join('\n');
    for (const character of text) parser.push(character);
    assert.deepEqual(parser.finish(), { sessionId });
    assert.deepEqual(parser.finish(), { sessionId });
  });
  test(`${provider} rejects foreign resume and conflicting IDs`, () => {
    for (const expected of [sessionId, undefined]) {
      const parser = new ProviderOutputParser(provider, expected);
      parser.push(events(provider)[0] ? JSON.stringify(events(provider)[0]) + '\n' : '');
      parser.push(events(provider, otherId).map(event => JSON.stringify(event)).join('\n'));
      assert.equal(parser.finish().error, 'provider_session_mismatch');
      assert.equal(parser.finish().sessionId, undefined);
    }
  });
  test(`${provider} requires terminal success and ignores nested fake IDs`, () => {
    const parser = new ProviderOutputParser(provider);
    parser.push(JSON.stringify({ type: 'assistant', message: { thread_id: sessionId, session_id: sessionId } }) + '\n');
    assert.equal(parser.finish().error, 'provider_session_missing');
    const started = new ProviderOutputParser(provider);
    started.push(JSON.stringify(events(provider)[0]));
    assert.deepEqual(started.finish(), { sessionId, error: 'provider_result_missing' });
  });
  test(`${provider} terminal failures override a prior success`, () => {
    const parser = new ProviderOutputParser(provider);
    parser.push(events(provider).map(event => JSON.stringify(event)).join('\n') + '\n');
    parser.push(JSON.stringify(provider === 'codex' ? { type: 'turn.failed' }
      : { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId }));
    assert.deepEqual(parser.finish(), { sessionId, error: 'provider_reported_failure' });
  });
}

test('invalid IDs, malformed JSON and excessive lines fail closed', () => {
  for (const line of ['not json', '[]', '{}', JSON.stringify({ type: 'thread.started', thread_id: '--last' }), 'x'.repeat(65537)]) {
    const parser = new ProviderOutputParser('codex');
    parser.push(line);
    assert.ok(parser.finish().error);
    assert.equal(parser.finish().sessionId, undefined);
  }
  const parser = new ProviderOutputParser('codex');
  const line = JSON.stringify({ type: 'item.completed', text: 'x'.repeat(8000) }) + '\n';
  for (let i = 0; i < 140; i++) parser.push(line);
  assert.equal(parser.finish().error, 'provider_output_limit_exceeded');
});

test('Claude result alone cannot establish identity', () => {
  const parser = new ProviderOutputParser('claude');
  parser.push(JSON.stringify(events('claude')[1]));
  assert.equal(parser.finish().error, 'provider_session_missing');
});
