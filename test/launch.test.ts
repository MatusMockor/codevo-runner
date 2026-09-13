import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseLaunchOptions, CLAUDE_MODEL_CHOICES, CODEX_MODEL_CHOICES } from '../src/domain/launch.js';
import { launchArguments, launchPrompt } from '../src/domain/launch-arguments.js';

const claude = (overrides: Record<string, unknown> = {}) => parseLaunchOptions({
  provider: 'claudeCode', model: 'default', mode: 'default', effort: 'default', ...overrides,
});

test('launch parser rejects arbitrary authority, unsupported capabilities and provider mismatch', () => {
  for (const value of [null, [], 'claude', {},
    { provider: 'claudeCode', model: 'default', mode: 'default' },
    { provider: 'codex', model: 'default', mode: 'default', effort: 'high' },
    { provider: 'codex', model: 'default', mode: 'workspaceWrite', args: ['--help'] },
    { provider: 'codex', model: 'gpt-6-astra --help', mode: 'default' },
    { provider: 'codex', model: 'default', mode: 'acceptEdits' },
  ]) assert.throws(() => parseLaunchOptions(value));
  for (const overrides of [
    { effort: null }, { context: null }, { fastMode: 'true' }, { thinkingMode: 1 },
    { model: 'fable', fastMode: true }, { model: 'sonnet', thinkingMode: true },
    { model: 'sonnet', effort: 'ultracode' }, { model: 'claude-opus-4-6', effort: 'xhigh' },
    { model: 'claude-opus-4-5', effort: 'ultrathink' }, { model: 'claude-haiku-4-5', effort: 'low' },
  ]) assert.throws(() => claude(overrides));
  assert.throws(() => parseLaunchOptions(claude(), 'codex'));
  assert.throws(() => parseLaunchOptions({ provider: 'codex', model: 'default', mode: 'default' }, 'claude'));
  assert.deepEqual(claude(), { provider: 'claudeCode', model: 'default', mode: 'default', effort: 'default', context: '200k', fastMode: false, thinkingMode: false });
  assert.ok(Object.isFrozen(claude()));
});

test('Claude model contexts match native model aliases and fixed windows', () => {
  const fixed = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-5', 'claude-haiku-4-5']);
  for (const model of CLAUDE_MODEL_CHOICES) {
    for (const context of ['200k', '1m']) {
      const expected = model === 'default' ? [] : ['--model', model + (context === '1m' && !fixed.has(model) ? '[1m]' : '')];
      if (model === 'claude-haiku-4-5') expected.push('--settings', '{"alwaysThinkingEnabled":false}');
      assert.deepEqual(launchArguments(claude({ model, context }), false), expected);
      assert.deepEqual(launchArguments(claude({ model, context }), true), expected);
    }
  }
});

test('Claude mode, effort and model-specific settings preserve local semantics', () => {
  const modes = { default: [], plan: ['--permission-mode', 'plan'], supervised: ['--permission-mode', 'default'], acceptEdits: ['--permission-mode', 'acceptEdits'], auto: ['--permission-mode', 'auto'], bypassPermissions: ['--dangerously-skip-permissions'] };
  for (const [mode, expected] of Object.entries(modes)) assert.deepEqual(launchArguments(claude({ mode }), false), expected);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.deepEqual(launchArguments(claude({ effort }), false), ['--effort', effort]);
  assert.deepEqual(launchArguments(claude({ model: 'opus', effort: 'ultracode', fastMode: true }), false), ['--model', 'opus', '--effort', 'xhigh', '--settings', '{"fastMode":true,"ultracode":true}']);
  assert.deepEqual(launchArguments(claude({ model: 'fable', effort: 'ultracode' }), false), ['--model', 'fable', '--effort', 'xhigh', '--settings', '{"ultracode":true}']);
  assert.deepEqual(launchArguments(claude({ model: 'opus', fastMode: true }), false), ['--model', 'opus', '--settings', '{"fastMode":true}']);
  assert.deepEqual(launchArguments(claude({ model: 'claude-haiku-4-5', thinkingMode: true }), false), ['--model', 'claude-haiku-4-5', '--settings', '{"alwaysThinkingEnabled":true}']);
});

test('Codex first-turn and resumed sandbox flags match native launch contract', () => {
  for (const model of CODEX_MODEL_CHOICES) {
    for (const resumed of [false, true]) {
      for (const mode of ['default', 'readOnly', 'workspaceWrite', 'auto', 'dangerFullAccess']) {
        const expected = model === 'default' ? [] : ['-m', model];
        if (mode === 'dangerFullAccess') expected.push('--dangerously-bypass-approvals-and-sandbox');
        if (['readOnly', 'workspaceWrite', 'auto'].includes(mode)) {
          const sandbox = mode === 'readOnly' ? 'read-only' : 'workspace-write';
          expected.push(...(resumed ? ['-c', `sandbox_mode="${sandbox}"`] : ['--sandbox', sandbox]));
        }
        assert.deepEqual(launchArguments(parseLaunchOptions({ provider: 'codex', model, mode }, 'codex'), resumed), expected);
      }
    }
  }
});

test('ultrathink preserves slash commands and prefixes other text exactly once', () => {
  const options = claude({ effort: 'ultrathink' });
  for (const [input, expected] of [
    [' Investigate this ', 'Ultrathink:\nInvestigate this'],
    [' /compact keep errors ', '/compact keep errors'],
    [' / compact ', '/ compact'],
    ['/home/developer/app.ts failed', 'Ultrathink:\n/home/developer/app.ts failed'],
    [' Ultrathink:\nexisting ', 'Ultrathink:\nexisting'],
    ['', 'Ultrathink:\n'], ['/', 'Ultrathink:\n/'],
  ]) assert.equal(launchPrompt(options, input!), expected);
  assert.equal(launchPrompt(claude(), ' untouched '), ' untouched ');
  assert.deepEqual(launchArguments(options, false), []);
});
