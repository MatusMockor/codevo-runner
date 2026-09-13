import { RunnerError, type MessagePart } from './contracts.js';
import { parseTaskInput } from './task-input.js';

export type ContinueTask = Readonly<{ idempotencyKey: string; parts: readonly MessagePart[] }>;
export type ResumeState = Readonly<{ available: boolean; reason: 'task_not_finished' | 'session_unavailable' | 'newer_turn_exists' | null }>;
export type TaskSession = Readonly<{ sessionId: string | null; workspaceTaskId: string }>;

export function parseContinueTask(value: unknown): ContinueTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !('idempotencyKey' in input) || !('parts' in input)) throw new RunnerError('invalid_input');
  const parsed = parseTaskInput({ ...input, provider: 'codex' });
  return { idempotencyKey: parsed.idempotencyKey, parts: parsed.parts };
}
