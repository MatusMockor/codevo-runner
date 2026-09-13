import { RunnerError } from './contracts.js';

export const CLAUDE_MODEL_CHOICES = [
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
export type ClaudeModelChoice = (typeof CLAUDE_MODEL_CHOICES)[number];

export const CLAUDE_PERMISSION_MODES = [
  "default",
  "plan",
  "supervised",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const CODEX_MODEL_CHOICES = [
  "default",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
] as const;
export type CodexModelChoice = (typeof CODEX_MODEL_CHOICES)[number];

export const CODEX_EXECUTION_MODES = [
  "default",
  "readOnly",
  "workspaceWrite",
  "auto",
  "dangerFullAccess",
] as const;
export type CodexExecutionMode = (typeof CODEX_EXECUTION_MODES)[number];

export const CLAUDE_EFFORT_CHOICES = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "ultrathink",
] as const;
export type ClaudeEffortChoice = (typeof CLAUDE_EFFORT_CHOICES)[number];
export const CLAUDE_CONTEXT_CHOICES = ["200k", "1m"] as const;
export type ClaudeContextChoice = (typeof CLAUDE_CONTEXT_CHOICES)[number];

export interface ClaudeLaunchOptions {
  readonly provider: "claudeCode";
  readonly model: ClaudeModelChoice;
  readonly mode: ClaudePermissionMode;
  readonly effort: ClaudeEffortChoice;
  readonly context?: ClaudeContextChoice;
  readonly fastMode?: boolean;
  readonly thinkingMode?: boolean;
}

export interface CodexLaunchOptions {
  readonly provider: "codex";
  readonly model: CodexModelChoice;
  readonly mode: CodexExecutionMode;
}

export type AgentLaunchOptions = ClaudeLaunchOptions | CodexLaunchOptions;

function invalid(): never {
  throw new RunnerError('invalid_input');
}

function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid();
  return value as T;
}

function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') invalid();
  return value;
}

/** Closed editor launch contract; omitted fields follow native serde defaults. */
export function parseLaunchOptions(value: unknown, provider?: 'claude' | 'codex'): AgentLaunchOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (input.provider !== 'claudeCode' && input.provider !== 'codex') invalid();
  if (provider !== undefined && (input.provider === 'claudeCode' ? 'claude' : 'codex') !== provider) invalid();
  const keys = input.provider === 'codex'
    ? ['provider', 'model', 'mode']
    : ['provider', 'model', 'mode', 'effort', 'context', 'fastMode', 'thinkingMode'];
  if (Object.keys(input).some(key => !keys.includes(key))) invalid();
  if (input.provider === 'codex') return Object.freeze({
    provider: 'codex',
    model: member(input.model, CODEX_MODEL_CHOICES),
    mode: member(input.mode, CODEX_EXECUTION_MODES),
  });
  const options: ClaudeLaunchOptions = {
    provider: 'claudeCode',
    model: member(input.model, CLAUDE_MODEL_CHOICES),
    mode: member(input.mode, CLAUDE_PERMISSION_MODES),
    effort: member(input.effort, CLAUDE_EFFORT_CHOICES),
    context: member(input.context === undefined ? '200k' : input.context, CLAUDE_CONTEXT_CHOICES),
    fastMode: flag(input.fastMode),
    thinkingMode: flag(input.thinkingMode),
  };
  validateCapabilities(options);
  return Object.freeze(options);
}

function validateCapabilities(options: ClaudeLaunchOptions): void {
  const { model, effort, fastMode, thinkingMode } = options;
  if (thinkingMode && model !== 'claude-haiku-4-5') invalid();
  if (fastMode && !['opus', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'].includes(model)) invalid();
  if (model === 'claude-haiku-4-5' && effort !== 'default') invalid();
  if (effort === 'xhigh' && !['default', 'fable', 'opus', 'sonnet', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5'].includes(model)) invalid();
  if (effort === 'ultracode' && !['fable', 'opus', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8'].includes(model)) invalid();
  if (effort === 'ultrathink' && ['claude-opus-4-5', 'claude-haiku-4-5'].includes(model)) invalid();
}
