import { RunnerError } from './contracts.js';

export type ClaudeModelChoice = string;

export const CLAUDE_PERMISSION_MODES = [
  "default",
  "plan",
  "supervised",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export type CodexModelChoice = string;

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

function modelId(value: unknown): string {
  if (typeof value !== 'string' || /^[a-z0-9][a-z0-9._-]{0,95}$/.exec(value)?.[0] !== value) invalid();
  return value;
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
    model: modelId(input.model),
    mode: member(input.mode, CODEX_EXECUTION_MODES),
  });
  const options: ClaudeLaunchOptions = {
    provider: 'claudeCode',
    model: modelId(input.model),
    mode: member(input.mode, CLAUDE_PERMISSION_MODES),
    effort: member(input.effort, CLAUDE_EFFORT_CHOICES),
    context: member(input.context === undefined ? '200k' : input.context, CLAUDE_CONTEXT_CHOICES),
    fastMode: flag(input.fastMode),
    thinkingMode: flag(input.thinkingMode),
  };
  return Object.freeze(options);
}
