import type { InstructionSnapshot } from './instructions.js';
import { parseLaunchOptions, type AgentLaunchOptions } from './launch.js';
import { RunnerError, type MessagePart } from './contracts.js';
import { parseTaskInput } from './task-input.js';

export type ContinueTask = Readonly<{ instructions?: InstructionSnapshot; idempotencyKey: string; launch?: AgentLaunchOptions; parts: readonly MessagePart[] }>;
export type ResumeState = Readonly<{ available: boolean; reason: 'task_not_finished' | 'session_unavailable' | 'newer_turn_exists' | null }>;
export type TaskSession = Readonly<{ sessionId: string | null; workspaceTaskId: string }>;

export function parseContinueTask(value: unknown): ContinueTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const input = value as Record<string, unknown>;
  const hasInstructions = Object.hasOwn(input, 'instructions');
  const hasLaunch = Object.hasOwn(input, 'launch');
  if (Object.keys(input).length !== (2 + Number(hasLaunch) + Number(hasInstructions)) || !('idempotencyKey' in input) || !('parts' in input)) throw new RunnerError('invalid_input');
  const launch = hasLaunch ? parseLaunchOptions(input.launch) : undefined;
  const parsed = parseTaskInput({ ...input, provider: launch?.provider === 'claudeCode' ? 'claude' : 'codex' });
  return { ...(parsed.instructions ? { instructions: parsed.instructions } : {}), idempotencyKey: parsed.idempotencyKey, parts: parsed.parts, ...(launch ? { launch } : {}) };
}
