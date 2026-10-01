import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseLaunchOptions } from '../src/domain/launch.js';
import { RunnerError } from '../src/domain/contracts.js';
import { launchArguments, launchPrompt } from '../src/domain/launch-arguments.js';

const CLAUDE_MODEL_CHOICES = [
  "default",
  "fable",
  "opus",
  "sonnet",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;
const CODEX_MODEL_CHOICES = [
  "default",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
] as const;

const claude = (overrides: Record<string, unknown> = {}) => parseLaunchOptions({
  provider: 'claudeCode', model: 'default', mode: 'default', effort: 'default', ...overrides,
});

test('launch parser rejects unknown keys, invalid closed choices and provider mismatch', () => {
  for (const value of [null, [], 'claude', {},
    { provider: 'claudeCode', model: 'default', mode: 'default' },
    { provider: 'codex', model: 'default', mode: 'default', effort: 'high' },
    { provider: 'codex', model: 'default', mode: 'workspaceWrite', args: ['--help'] },
    { provider: 'codex', model: 'gpt-6-astra --help', mode: 'default' },
    { provider: 'codex', model: 'default', mode: 'acceptEdits' },
  ]) assert.throws(() => parseLaunchOptions(value));
  for (const overrides of [
    { effort: null }, { context: null }, { fastMode: 'true' }, { thinkingMode: 1 },
    { effort: 'extreme' }, { context: '2m' }, { mode: 'readOnly' }, { args: [] },
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

test('model IDs accept safe syntax for either provider and reject unsafe values', () => {
  for (const provider of ['claudeCode', 'codex']) {
    const input = { provider, mode: 'default', ...(provider === 'claudeCode' ? { effort: 'default' } : {}) };
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra', 'gpt-5.6-sol', 'future-model', '0', 'a'.repeat(96), 'a._-0']) {
      assert.equal(parseLaunchOptions({ ...input, model }).model, model);
    }
    for (const model of ['', '-rf', '--model', 'Claude-Opus', 'claude opus', 'claude-opus-5-5[1m]', 'a/b', 'a'.repeat(97), 42, null, undefined, {}, 'claude-ö', 'model\n']) {
      assert.throws(() => parseLaunchOptions({ ...input, model }), (error: unknown) => error instanceof RunnerError && error.code === 'invalid_input');
    }
  }
});

test('the editor owns model capabilities', () => {
  for (const overrides of [
    { model: 'fable', fastMode: true }, { model: 'sonnet', thinkingMode: true },
    { model: 'sonnet', effort: 'ultracode' }, { model: 'claude-opus-4-6', effort: 'xhigh' },
    { model: 'claude-opus-4-5', effort: 'ultrathink' }, { model: 'claude-haiku-4-5', effort: 'low' },
  ]) assert.doesNotThrow(() => claude(overrides));
  assert.deepEqual(launchArguments(claude({ model: 'claude-opus-5-5', context: '1m', effort: 'ultracode', fastMode: true }), false), [
    '--model', 'claude-opus-5-5[1m]', '--effort', 'xhigh', '--settings', '{"fastMode":true,"ultracode":true}',
  ]);
});

test('non-haiku thinking merges with fast mode and ultracode in one settings object', () => {
  for (const model of ['default', 'sonnet', 'claude-opus-5-5']) {
    for (const fastMode of [false, true]) {
      for (const effort of ['default', 'ultracode']) {
        for (const thinkingMode of [undefined, false, true]) {
          const settings = {
            ...(fastMode ? { fastMode: true } : {}),
            ...(effort === 'ultracode' ? { ultracode: true } : {}),
            ...(thinkingMode ? { alwaysThinkingEnabled: true } : {}),
          };
          const expected = [
            ...(model === 'default' ? [] : ['--model', model]),
            ...(effort === 'ultracode' ? ['--effort', 'xhigh'] : []),
            ...(Object.keys(settings).length ? ['--settings', JSON.stringify(settings)] : []),
          ];
          for (const resumed of [false, true]) assert.deepEqual(launchArguments(claude({ model, fastMode, effort, thinkingMode }), resumed), expected);
        }
      }
    }
  }
  for (const thinkingMode of [undefined, false, true]) {
    assert.deepEqual(launchArguments(claude({ model: 'claude-haiku-4-5', thinkingMode }), false), [
      '--model', 'claude-haiku-4-5', '--settings', JSON.stringify({ alwaysThinkingEnabled: thinkingMode ?? false }),
    ]);
  }
});
