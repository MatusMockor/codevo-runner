import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderOutputParser } from '../src/domain/provider-output.js';
import { ProviderArtifactReferences } from '../src/domain/artifact-output.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
function assistant(provider: 'codex' | 'claude', text: string): string {
  return JSON.stringify(provider === 'codex'
    ? { type: 'item.completed', item: { type: 'agent_message', text } }
    : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} preserves session, final result and artifacts after multi-megabyte streaming output`, () => {
    const result = new ProviderOutputParser(provider, sessionId);
    const artifacts = new ProviderArtifactReferences(provider);
    const push = (text: string) => { result.push(text); artifacts.push(text); };
    push(JSON.stringify(provider === 'codex'
      ? { type: 'thread.started', thread_id: sessionId }
      : { type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
    const progress = JSON.stringify({ type: 'progress', text: 'á'.repeat(8000) }) + '\n';
    for (let i = 0; i < 300; i++) push(progress);
    assert.ok(Buffer.byteLength(progress) * 300 > 4 * 1024 * 1024);
    push(assistant(provider, '[Design](design.html) ![Image](image.png)') + '\n');
    const final = JSON.stringify(provider === 'codex'
      ? { type: 'turn.completed' }
      : { type: 'result', subtype: 'success', is_error: false, session_id: sessionId });
    for (const char of final) push(char);
    assert.deepEqual(result.finish(), { sessionId });
    assert.deepEqual(artifacts.finish(), ['design.html', 'image.png']);
    assert.equal(artifacts.isComplete(), true);
  });

  test(`${provider} artifact discovery resumes after a split oversized frame and reports incomplete discovery`, () => {
    const parser = new ProviderArtifactReferences(provider);
    parser.push(assistant(provider, '[Before](before.png)') + '\n');
    parser.push('{"type":"progress","text":"');
    for (let i = 0; i < 70; i++) parser.push('á'.repeat(4096));
    parser.push('"}\n' + assistant(provider, '[After](after.html)') + '\n');
    parser.push(assistant(provider, '[Last](last.png)'));
    assert.deepEqual(parser.finish(), ['before.png', 'after.html', 'last.png']);
    assert.equal(parser.isComplete(), false);
    parser.push(assistant(provider, '[Ignored](ignored.png)'));
    assert.deepEqual(parser.finish(), ['before.png', 'after.html', 'last.png']);
  });

  test(`${provider} artifact discovery resumes after an oversized frame in one chunk`, () => {
    const parser = new ProviderArtifactReferences(provider);
    parser.push('x'.repeat(300_000) + '\n' + assistant(provider, '[After](after.png)') + '\n');
    assert.deepEqual(parser.finish(), ['after.png']);
    assert.equal(parser.isComplete(), false);
  });

  test(`${provider} metadata parser still rejects an oversized frame without accepting a subsequent result`, () => {
    const parser = new ProviderOutputParser(provider);
    parser.push(JSON.stringify({ type: 'progress', text: 'á'.repeat(40_000) }) + '\n');
    parser.push(JSON.stringify({ type: 'turn.completed' }) + '\n');
    assert.deepEqual(parser.finish(), { error: 'provider_output_limit_exceeded' });
  });
}
