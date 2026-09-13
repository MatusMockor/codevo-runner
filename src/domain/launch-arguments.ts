import type { AgentLaunchOptions, ClaudeLaunchOptions } from './launch.js';

/** Arguments contain only validated semantic launch choices, never shell text. */
export function launchArguments(options: AgentLaunchOptions, resumed: boolean): string[] {
  if (options.provider === 'codex') {
    const model = options.model === 'default' ? [] : ['-m', options.model];
    if (options.mode === 'default') return model;
    if (options.mode === 'dangerFullAccess') return [...model, '--dangerously-bypass-approvals-and-sandbox'];
    const sandbox = options.mode === 'readOnly' ? 'read-only' : 'workspace-write';
    return [...model, ...(resumed ? ['-c', `sandbox_mode="${sandbox}"`] : ['--sandbox', sandbox])];
  }
  return [...claudeModel(options), ...claudeMode(options), ...claudeEffort(options), ...claudeSettings(options)];
}

function claudeModel(options: ClaudeLaunchOptions): string[] {
  if (options.model === 'default') return [];
  const fixedContext = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-5', 'claude-haiku-4-5'].includes(options.model);
  const suffix = options.context === '1m' && !fixedContext ? '[1m]' : '';
  return ['--model', options.model + suffix];
}

function claudeMode(options: ClaudeLaunchOptions): string[] {
  if (options.mode === 'default') return [];
  if (options.mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', options.mode === 'supervised' ? 'default' : options.mode];
}

function claudeEffort(options: ClaudeLaunchOptions): string[] {
  if (options.effort === 'default' || options.effort === 'ultrathink') return [];
  return ['--effort', options.effort === 'ultracode' ? 'xhigh' : options.effort];
}

function claudeSettings(options: ClaudeLaunchOptions): string[] {
  if (options.model === 'claude-haiku-4-5') {
    return ['--settings', JSON.stringify({ alwaysThinkingEnabled: options.thinkingMode ?? false })];
  }
  if (options.effort === 'ultracode' && options.fastMode) return ['--settings', '{"fastMode":true,"ultracode":true}'];
  if (options.effort === 'ultracode') return ['--settings', '{"ultracode":true}'];
  if (options.fastMode) return ['--settings', '{"fastMode":true}'];
  return [];
}

export function launchPrompt(options: AgentLaunchOptions, prompt: string): string {
  if (options.provider !== 'claudeCode' || options.effort !== 'ultrathink') return prompt;
  const trimmed = prompt.trim();
  const token = trimmed.startsWith('/') ? trimmed.slice(1).trimStart().split(/\s/u)[0] : '';
  if (trimmed.startsWith('Ultrathink:') || (token && !token.includes('/'))) return trimmed;
  return `Ultrathink:\n${trimmed}`;
}
