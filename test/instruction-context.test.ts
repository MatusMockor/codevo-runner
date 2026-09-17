import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instructionContext, materializedInstructionFiles } from '../src/domain/instruction-context.js';
import type { InstructionSnapshot } from '../src/domain/instructions.js';

const snapshot: InstructionSnapshot = { version: 1, files: [
  { scope: 'global', path: 'CLAUDE.md', content: 'Global root\n@support.md' },
  { scope: 'global', path: 'support.md', content: 'Imported support' },
  { scope: 'global', path: 'rules/style.md', content: '---\npaths: ["src/**"]\n---\n@../support.md' },
  { scope: 'project', path: 'CLAUDE.md', content: '@docs/conventions.md' },
  { scope: 'project', path: 'docs/conventions.md', content: 'Supporting project doc' },
  { scope: 'project', path: 'src/CLAUDE.local.md', content: 'Only src' },
] };

test('preserves native hierarchy, frontmatter and relocated global import targets', () => {
  const files = materializedInstructionFiles(snapshot);
  assert.equal(files.find(file => file.path === '.claude/rules/codevo-global/style.md')?.content,
    '---\npaths: ["src/**"]\n---\n@../../../.codevo-instructions/global/support.md');
  assert.equal(files.find(file => file.path === 'src/CLAUDE.local.md')?.content, 'Only src');
  assert.equal(files.find(file => file.path === 'CLAUDE.md')?.content, '@docs/conventions.md');
});

test('fresh context expands global root only and indexes entry points without flattening project rules', () => {
  const context = instructionContext(snapshot);
  assert.match(context, /Global root\nImported support/u);
  assert.match(context, /replace earlier synchronized instruction snapshots/u);
  assert.match(context, /"src\/CLAUDE.local.md"/u);
  assert.doesNotMatch(context, /Only src|Supporting project doc|"docs\/conventions.md"/u);
});

test('closed imports reject missing, escaping and circular references but ignore code samples', () => {
  for (const content of ['@missing.md', '@../outside.md', '@CLAUDE.md', '@/etc/passwd', '@~/secret.txt', '(@/etc/passwd)']) {
    assert.throws(() => instructionContext({ version: 1, files: [{scope: 'global', path: 'CLAUDE.md', content}] }));
  }
  assert.doesNotThrow(() => instructionContext({ version: 1, files: [{scope: 'global', path: 'CLAUDE.md', content: '`@missing.md`\n```md\n@missing.md\n```'}] }));
});

test('generated namespaces cannot collide with project snapshot files', () => {
  assert.throws(() => materializedInstructionFiles({ version: 1, files: [
    {scope: 'global', path: 'rules/style.md', content: 'global'},
    {scope: 'project', path: '.claude/rules/codevo-global/style.md', content: 'project'},
  ] }));
});

test('relative imported Markdown supports case-insensitive extensions consistently', () => {
  const snapshot: InstructionSnapshot = {version:1,files:[
    {scope:'global',path:'CLAUDE.md',content:'@docs/RULES.MD'},
    {scope:'global',path:'docs/RULES.MD',content:'Uppercase extension'},
  ]};
  assert.match(instructionContext(snapshot), /Uppercase extension/);
  assert.equal(materializedInstructionFiles(snapshot).length, 2);
});

test('prose annotations survive materialization and context expansion alongside genuine imports', () => {
  const prose = 'Only tooling annotations (e.g. @param/@var type annotations, @throws) are allowed.';
  const rules: InstructionSnapshot = { version: 1, files: [
    { scope: 'global', path: 'CLAUDE.md', content: `${prose}\n@docs/general.md\n@param.md\n@throws.md` },
    { scope: 'global', path: 'docs/general.md', content: 'General rules' },
    { scope: 'global', path: 'param.md', content: 'Parameter rules' },
    { scope: 'global', path: 'throws.md', content: 'Exception rules' },
  ] };
  assert.equal(materializedInstructionFiles(rules)[0]?.content, rules.files[0]?.content);
  const context = instructionContext(rules);
  assert.ok(context.includes(prose));
  assert.match(context, /General rules\nParameter rules\nException rules/);
});

test('quoted and standalone annotation-shaped imports still fail closed', () => {
  for (const content of ['@param', '@"param"', 'Import @"param"', '@param/secret.txt']) {
    const rules: InstructionSnapshot = { version: 1, files: [{ scope: 'global', path: 'CLAUDE.md', content }] };
    assert.throws(() => materializedInstructionFiles(rules));
    assert.throws(() => instructionContext(rules));
  }
});
