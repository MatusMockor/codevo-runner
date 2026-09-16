import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderArtifactReferences } from '../src/domain/artifact-output.js';
const codex = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
const claude = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('artifact references decode chunked complete assistant output for both providers', () => {
  for (const provider of ['codex', 'claude'] as const) {
    const parser = new ProviderArtifactReferences(provider);
    const text = '[Design](<design with spaces.html>) ![Image](/workspace/image.png "Preview") [Other](./photo.JPEG) [WebP](image.webp) [Page](page.htm) [same](./photo.JPEG)';
    const output = (provider === 'codex' ? codex : claude)(text);
    for (let index = 0; index < output.length; index += 7) parser.push(output.slice(index, index + 7));
    const expected = ['design with spaces.html', '/workspace/image.png', './photo.JPEG', 'image.webp', 'page.htm'];
    assert.deepEqual(parser.finish(), expected);
    parser.push(codex('[Late](late.png)'));
    assert.deepEqual(parser.finish(), expected);
  }
});

test('artifact references reject user, tools, partial updates and subagents', () => {
  const link = '[Private](private.png)';
  const events = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: link }] } },
    { type: 'assistant', parent_tool_use_id: 'subagent', message: { role: 'assistant', content: [{ type: 'text', text: link }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', text: link }] } },
    { type: 'item.updated', item: { type: 'agent_message', text: link } },
    { type: 'item.completed', parent_tool_use_id: 'subagent', item: { type: 'agent_message', text: link } },
    { type: 'item.completed', item: { type: 'command_execution', text: link } },
  ];
  for (const provider of ['codex', 'claude'] as const) {
    const parser = new ProviderArtifactReferences(provider);
    parser.push(events.map(value => JSON.stringify(value)).join('\n'));
    assert.deepEqual(parser.finish(), []);
  }
});

test('artifact references reject URLs, traversal and unsupported paths and cap unique references', () => {
  const parser = new ProviderArtifactReferences('codex');
  const invalid = ['https://example.com/a.png', 'data:image/png;base64,a', 'file:///a.png', '//host/a.png', '../a.png', 'dir/../a.png', '.git/a.png', 'a.svg', 'a.png?x=1', 'a.png#x', 'a\\b.png'];
  parser.push(codex(invalid.map(path => `[x](${path})`).join(' ')) + '\n');
  parser.push(codex(Array.from({ length: 50 }, (_, i) => `[x](image-${i}.png)`).join(' ')));
  assert.deepEqual(parser.finish(), Array.from({ length: 32 }, (_, i) => `image-${i}.png`));
});

test('artifact discovery fails closed at stream and line byte budgets', () => {
  const line = new ProviderArtifactReferences('codex');
  line.push(codex('[Good](good.png)') + '\n');
  line.push('x'.repeat(256 * 1024 + 1));
  assert.deepEqual(line.finish(), ['good.png']);
  assert.equal(line.isComplete(), false);
  const stream = new ProviderArtifactReferences('claude');
  stream.push(claude('[Good](good.png)') + '\n');
  for (let i = 0; i < 1100; i++) stream.push('x'.repeat(1024) + '\n');
  assert.deepEqual(stream.finish(), ['good.png']);
  assert.equal(stream.isComplete(), false);
  const path = new ProviderArtifactReferences('codex');
  path.push(codex(`[Long](<${'á'.repeat(2100)}.png>)`));
  assert.deepEqual(path.finish(), []);
});

 test('artifact references decode destinations and skip code examples', () => {
  const parser = new ProviderArtifactReferences('codex');
  parser.push(codex('[Design](design%20file.html) [bad](%2e%2e/private.png) `![Example](example.png)`\n```html\n[x](code.html)\n```\n[Paren](design\\(1\\).html)'));
  assert.deepEqual(parser.finish(), ['design file.html', 'design(1).html']);
});
