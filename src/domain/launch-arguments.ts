import type { AgentLaunchOptions, ClaudeLaunchOptions } from './launch.js';
import { isConfigurableMcpServerName } from './mcp-server-management.js';

const ALLOWED_TOOLS = '--allowedTools';
const MAX_PREAPPROVED_MCP_SERVERS = 96;

/** Arguments contain only validated semantic launch choices, never shell text. */
export function launchArguments(options: AgentLaunchOptions, resumed: boolean): string[] {
  if (options.provider === 'codex') {
    const model = options.model === 'default' ? [] : ['-m', options.model];
    const effort = !options.effort || options.effort === 'default' ? [] : ['-c', `model_reasoning_effort="${options.effort}"`];
    if (options.mode === 'default') return [...model, ...effort];
    if (options.mode === 'dangerFullAccess') return [...model, '--dangerously-bypass-approvals-and-sandbox', ...effort];
    const sandbox = options.mode === 'readOnly' ? 'read-only' : 'workspace-write';
    return [...model, ...(resumed ? ['-c', `sandbox_mode="${sandbox}"`] : ['--sandbox', sandbox]), ...effort];
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
  const settings = {
    ...(options.fastMode ? { fastMode: true } : {}),
    ...(options.effort === 'ultracode' ? { ultracode: true } : {}),
    ...(options.thinkingMode ? { alwaysThinkingEnabled: true } : {}),
  };
  return Object.keys(settings).length ? ['--settings', JSON.stringify(settings)] : [];
}

export function isPreapprovableMcpServerName(name: string): boolean {
  return isConfigurableMcpServerName(name) && !name.includes('__') && !name.startsWith('_');
}

export function withMcpServerPreapproval(args: readonly string[], launch: AgentLaunchOptions | undefined, servers: readonly string[]): string[] {
  if (launch?.provider === 'codex' || launch?.mode === 'bypassPermissions') return [...args];
  const tools = [...new Set(servers.filter(isPreapprovableMcpServerName))].slice(0, MAX_PREAPPROVED_MCP_SERVERS).map(name => `mcp__${name}`);
  if (tools.length === 0) return [...args];
  const index = args.indexOf(ALLOWED_TOOLS);
  if (index < 0 || index + 1 >= args.length) return [...args, ALLOWED_TOOLS, tools.join(',')];
  return args.map((value, position) => position === index + 1 ? [value, ...tools].join(',') : value);
}

export function launchPrompt(options: AgentLaunchOptions, prompt: string): string {
  if (options.provider !== 'claudeCode' || options.effort !== 'ultrathink') return prompt;
  const trimmed = prompt.trim();
  const token = trimmed.startsWith('/') ? trimmed.slice(1).trimStart().split(/\s/u)[0] : '';
  if (trimmed.startsWith('Ultrathink:') || (token && !token.includes('/'))) return trimmed;
  return `Ultrathink:\n${trimmed}`;
}
