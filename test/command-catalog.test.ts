import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMMAND_CATALOG_LIMITS, COMMAND_NAME_PATTERN, parseClaudeCommands, parseCodexSkills, sanitizeCatalogText,
  validateCommandCatalog, type CommandCatalogEntry,
} from '../src/domain/command-catalog.js';

type Example = Readonly<{ name: string; value: unknown }>;
type Fixture = Readonly<{
  schemaVersion: number; remoteRunnerCapability: string; remoteRunnerRoute: string; limits: Readonly<Record<string, number | string>>;
  catalogs: readonly Example[]; rejectedCatalogs: readonly Example[];
}>;
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/agent-command-catalog-wire.json', import.meta.url), 'utf8')) as Fixture;

const bytes = (value: string | null) => Buffer.byteLength(value ?? '');
const command = (name: string, changed: Partial<CommandCatalogEntry> = {}): CommandCatalogEntry =>
  ({ kind: 'command', name, label: null, description: null, argumentHint: null, builtin: false, ...changed });
const envelope = (entries: readonly unknown[], provider = 'claudeCode') => ({ version: 1, provider, truncated: false, entries });
function claudeReply(commands: unknown, requestId = 'request-1', subtype = 'success'): string {
  return JSON.stringify({ type: 'control_response', response: { subtype, request_id: requestId,
    response: { commands, models: [{ value: 'synthetic-model' }], account: { email: 'person@example.invalid', organization: 'Synthetic Org' } } } });
}

test('catalog validator shares limits with the editor and accepts and rejects exactly the fixture payloads', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.remoteRunnerCapability, 'commandCatalog');
  assert.equal(fixture.remoteRunnerRoute, '/v1/projects/{projectId}/command-catalog/{claude|codex}');
  const { outputBytes, ...shared } = COMMAND_CATALOG_LIMITS;
  assert.equal(outputBytes, 2 * 1024 * 1024);
  for (const [name, value] of Object.entries(shared)) assert.equal(fixture.limits[name], value, name);
  assert.equal(fixture.limits.namePattern, COMMAND_NAME_PATTERN.source);
  assert.ok(fixture.catalogs.length >= 4 && fixture.rejectedCatalogs.length >= 15);
  for (const example of fixture.catalogs) assert.deepEqual(validateCommandCatalog(example.value), example.value, example.name);
  for (const example of fixture.rejectedCatalogs) assert.throws(() => validateCommandCatalog(example.value), { message: 'invalid_command_catalog' }, example.name);
});

test('catalog validator bounds names, text bytes, entry count and well-formed trimmed text', () => {
  assert.doesNotThrow(() => validateCommandCatalog(envelope([command('a'.repeat(128), { description: 'é'.repeat(256), argumentHint: 'x'.repeat(128) })])));
  assert.doesNotThrow(() => validateCommandCatalog(envelope(Array.from({ length: 512 }, (_, index) => command(`c${index}`)))));
  for (const entry of [command('a'.repeat(129)), command('__internal'), command('ok', { description: 'é'.repeat(257) }),
    command('ok', { argumentHint: 'x'.repeat(129) }), command('ok', { description: ' padded' }), command('ok', { description: 'padded ' }),
    command('ok', { description: 'lone \ud800 surrogate' }), command('ok', { description: 'next\u0085line' }), command('ok', { label: 3 as unknown as string }),
    { ...command('ok'), description: undefined }, null, 'pr', []])
    assert.throws(() => validateCommandCatalog(envelope([entry])), { message: 'invalid_command_catalog' });
  assert.throws(() => validateCommandCatalog(envelope([{ kind: 'skill', name: 'pet', label: 'é'.repeat(65), description: null, argumentHint: null, builtin: false }], 'codex')));
  assert.throws(() => validateCommandCatalog(envelope(Array.from({ length: 513 }, (_, index) => command(`c${index}`)))));
  for (const value of [null, [], 'catalog', { ...envelope([]), entries: {} }, { ...envelope([]), truncated: 'no' }]) assert.throws(() => validateCommandCatalog(value));
});

test('text sanitizing collapses controls and whitespace and truncates on code point boundaries', () => {
  assert.equal(sanitizeCatalogText('  Open a\r\n\tpull\u0000  request. Now ', 512), 'Open a pull request. Now');
  for (const empty of ['', ' \n\t ', '\u0000\u001f', null, undefined, 7, {}]) assert.equal(sanitizeCatalogText(empty, 512), null);
  assert.equal(sanitizeCatalogText('lone \ud800 surrogate', 512), 'lone � surrogate');
  assert.equal(sanitizeCatalogText('é'.repeat(300), 512), 'é'.repeat(256));
  assert.equal(sanitizeCatalogText('a' + 'é'.repeat(300), 512), 'a' + 'é'.repeat(255));
  assert.equal(sanitizeCatalogText('😀'.repeat(200), 512), '😀'.repeat(128));
  assert.equal(sanitizeCatalogText('ab' + '😀'.repeat(200), 512), 'ab' + '😀'.repeat(127));
  assert.equal(sanitizeCatalogText('abc' + '😀'.repeat(200), 512), 'abc' + '😀'.repeat(127));
  assert.equal(sanitizeCatalogText('x'.repeat(511) + ' tail', 512), 'x'.repeat(511));
  assert.equal(sanitizeCatalogText('x'.repeat(512), 512), 'x'.repeat(512));
  assert.equal(sanitizeCatalogText('😀', 3), null);
  for (const prefix of ['', 'a', 'ab', 'abc']) {
    const text = sanitizeCatalogText(prefix + '😀'.repeat(200), 128)!;
    assert.ok(bytes(text) <= 128 && bytes(text) > 124 && !text.includes('�') && !/\p{Cs}/u.test(text), prefix);
  }
});

test('Claude initialize reply maps only commands and drops invalid, internal and duplicate names', () => {
  const output = claudeReply([
    { name: 'pr', description: '  Open a\n\tpull   request. ', argumentHint: ' [title] ', builtin: true, aliases: ['p'] },
    { name: 'plain' },
    { name: '__internal', description: 'Hidden.' },
    { name: 'bad name' }, { name: '/slash' }, { name: '' }, { name: 'x'.repeat(129) }, { name: 7 }, { description: 'No name.' }, 'junk', null, ['pr'],
    { name: 'pr', description: 'Duplicate.' },
    { name: 'superpowers:brainstorm.v2_x-y', description: 9, argumentHint: '   ', builtin: 'yes' },
    { name: 'long', description: 'é'.repeat(700), argumentHint: '😀'.repeat(40) },
  ]) + '\n';
  const catalog = parseClaudeCommands(output, 'request-1');
  assert.deepEqual(catalog, { version: 1, provider: 'claudeCode', truncated: false, entries: [
    command('pr', { description: 'Open a pull request.', argumentHint: '[title]', builtin: true }),
    command('plain'),
    command('superpowers:brainstorm.v2_x-y'),
    command('long', { description: 'é'.repeat(256), argumentHint: '😀'.repeat(32) }),
  ] });
  assert.deepEqual(validateCommandCatalog(JSON.parse(JSON.stringify(catalog))), catalog);
  const text = JSON.stringify(catalog);
  for (const secret of ['example.invalid', 'Synthetic Org', 'synthetic-model', 'account', 'aliases', 'models']) assert.equal(text.includes(secret), false, secret);
});

test('Claude parser skips unrelated lines and fails closed on missing, foreign, failed or malformed replies', () => {
  const unrelated = ['warning: not json', JSON.stringify({ type: 'system', subtype: 'init', commands: [{ name: 'system-line' }] }),
    JSON.stringify(['control_response']), '7', claudeReply([{ name: 'foreign' }], 'request-0'), ''].join('\n');
  assert.deepEqual(parseClaudeCommands(unrelated + '\n' + claudeReply([{ name: 'mine' }]) + '\n' + claudeReply([{ name: 'later' }]) + '\n', 'request-1').entries, [command('mine')]);
  assert.deepEqual(parseClaudeCommands(claudeReply([]), 'request-1'), { version: 1, provider: 'claudeCode', truncated: false, entries: [] });
  const reply = claudeReply([{ name: 'pr' }]);
  for (const output of ['', '\n\n', 'not json', reply.slice(0, -5), unrelated, claudeReply([{ name: 'pr' }], 'request-1', 'error'),
    claudeReply({ pr: { name: 'pr' } }), claudeReply(undefined), claudeReply(null),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'request-1' } }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'request-1', response: 'commands' } }),
    JSON.stringify({ type: 'control_request', response: { subtype: 'success', request_id: 'request-1', response: { commands: [] } } })])
    assert.throws(() => parseClaudeCommands(output, 'request-1'), { message: 'invalid_command_catalog' });
});

test('more valid entries than the limit keep the first in source order and report truncation', () => {
  const names = Array.from({ length: 600 }, (_, index) => `c${index}`);
  const noisy = names.flatMap((name, index) => index % 100 === 0 ? [{ name }, { name }, { name: `bad ${index}` }] : [{ name }]);
  const catalog = parseClaudeCommands(claudeReply(noisy), 'request-1');
  assert.equal(catalog.truncated, true);
  assert.deepEqual(catalog.entries.map(entry => entry.name), names.slice(0, 512));
  const exact = parseClaudeCommands(claudeReply([...names.slice(0, 512).map(name => ({ name })), { name: 'c0' }, { name: '__hidden' }, { name: 'bad name' }]), 'request-1');
  assert.equal(exact.truncated, false);
  assert.equal(exact.entries.length, 512);
  const skills = parseCodexSkills({ data: [{ cwd: '/work/project', skills: names.slice(0, 513).map(name => ({ name })) }] }, '/work/project');
  assert.equal(skills.truncated, true);
  assert.equal(skills.entries.length, 512);
  assert.equal(skills.entries.at(-1)?.name, 'c511');
});

test('Codex skills map labels, descriptions and system scope for the requested directory without paths', () => {
  const skill = (name: string, changed: Partial<CommandCatalogEntry> = {}): CommandCatalogEntry =>
    ({ kind: 'skill', name, label: null, description: null, argumentHint: null, builtin: false, ...changed });
  const other = { cwd: '/work/other', skills: [{ name: 'foreign', description: 'Another directory.', scope: 'user', enabled: true }], errors: [] };
  const result = { data: [
    other,
    { cwd: '/work/project', errors: [], skills: [
      { name: 'work-pets:create-pet', description: 'Long description of the pet skill.', shortDescription: null,
        interface: { displayName: ' Create\nPet ', shortDescription: 'Create a pet.' }, path: '/home/synthetic/.codex/skills/create-pet/SKILL.md', scope: 'user', enabled: true },
      { name: 'skill-creator', description: 'Create or update a skill.', interface: null, path: '/home/synthetic/.codex/skills/.system/skill-creator/SKILL.md', scope: 'system', enabled: true },
      { name: 'short', description: 'Long.', shortDescription: 'Short wins.', interface: { displayName: '   ', shortDescription: 'Interface.' }, scope: 'repo' },
      { name: 'disabled', description: 'Off.', scope: 'user', enabled: false },
      { name: 'bad name', description: 'Invalid.' }, { name: '__internal' }, { name: 7 }, 'junk', null,
      { name: 'short', description: 'Duplicate.' },
      { name: 'bare' },
      { name: 'wide', description: '😀'.repeat(200), interface: { displayName: 'é'.repeat(100) }, scope: 'System' },
    ] },
  ] };
  const catalog = parseCodexSkills(result, '/work/project');
  assert.deepEqual(catalog, { version: 1, provider: 'codex', truncated: false, entries: [
    skill('work-pets:create-pet', { label: 'Create Pet', description: 'Create a pet.' }),
    skill('skill-creator', { description: 'Create or update a skill.', builtin: true }),
    skill('short', { description: 'Short wins.' }),
    skill('bare'),
    skill('wide', { label: 'é'.repeat(64), description: '😀'.repeat(128) }),
  ] });
  assert.deepEqual(validateCommandCatalog(JSON.parse(JSON.stringify(catalog))), catalog);
  const text = JSON.stringify(catalog);
  for (const secret of ['synthetic', 'SKILL.md', 'path', 'foreign']) assert.equal(text.includes(secret), false, secret);
  assert.throws(() => parseCodexSkills(result, '/work/unlisted'), { message: 'invalid_command_catalog' });
  assert.throws(() => parseCodexSkills({ data: [other] }, '/work/project'), { message: 'invalid_command_catalog' });
  assert.deepEqual(parseCodexSkills({ data: [{ cwd: '/work/project', skills: [] }] }, '/work/project'), { version: 1, provider: 'codex', truncated: false, entries: [] });
  for (const malformed of [undefined, null, 'data', [], {}, { data: {} }, { data: [] }, { data: ['listing'] }, { data: [{ cwd: '/work/project' }] }, { data: [{ cwd: '/work/project', skills: {} }] }])
    assert.throws(() => parseCodexSkills(malformed, '/work/project'), { message: 'invalid_command_catalog' });
});

test('Codex skills are taken only from the single listing of the requested directory', () => {
  const listing = (cwd: string, name: string) => ({ cwd, skills: [{ name }], errors: [] });
  const mine = listing('/work/project', 'mine');
  assert.deepEqual(parseCodexSkills({ data: [listing('/work/other', 'foreign'), mine, listing('/work/project/', 'slash')] }, '/work/project').entries.map(entry => entry.name), ['mine']);
  for (const data of [[listing('/work/other', 'foreign')], [listing('/work/other', 'foreign'), listing('/work', 'parent')], [mine, mine], [mine, listing('/work/project', 'twin')],
    [listing('/work/project/', 'slash')], [listing('/WORK/project', 'case')], [{ skills: [{ name: 'no-cwd' }] }], [{ ...mine, cwd: ['/work/project'] }]])
    assert.throws(() => parseCodexSkills({ data }, '/work/project'), { message: 'invalid_command_catalog' });
});

test('Codex skills that failed to load mark the catalog truncated without exposing the failure', () => {
  const listing = (errors: unknown) => ({ data: [{ cwd: '/work/project', skills: [{ name: 'loaded', description: 'Loaded.' }], ...(errors === undefined ? {} : { errors }) }] });
  for (const errors of [undefined, null, [], {}, 'none', 0])
    assert.equal(parseCodexSkills(listing(errors), '/work/project').truncated, false, JSON.stringify(errors));
  for (const errors of [[{ path: '/home/synthetic/.codex/skills/broken/SKILL.md', message: 'private failure' }], ['broken'], [null]]) {
    const catalog = parseCodexSkills(listing(errors), '/work/project');
    assert.deepEqual(validateCommandCatalog(catalog), { version: 1, provider: 'codex', truncated: true,
      entries: [{ kind: 'skill', name: 'loaded', label: null, description: 'Loaded.', argumentHint: null, builtin: false }] });
    for (const secret of ['synthetic', 'SKILL.md', 'private failure', 'broken', 'errors']) assert.equal(JSON.stringify(catalog).includes(secret), false, secret);
  }
  assert.deepEqual(parseCodexSkills({ data: [{ cwd: '/work/project', skills: [], errors: ['broken'] }] }, '/work/project'), { version: 1, provider: 'codex', truncated: true, entries: [] });
});
