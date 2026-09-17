import { RunnerError, isId } from './contracts.js';
export const TERMINAL_LIMITS = Object.freeze({ sessions: 16, retainedBytes: 1_048_576, pageBytes: 262_144, inputBytes: 65_536, idleMs: 24 * 60 * 60 * 1000 });
export type TerminalSize = Readonly<{ cols: number; rows: number }>;
export type TerminalSnapshot = TerminalSize & Readonly<{ id: string; projectId: string; taskId: string | null; status: 'running' | 'exited'; exitCode: number | null; sequence: number }>;
export type TerminalChunk = Readonly<{ sequence: number; data: string }>;
export type TerminalPage = TerminalSnapshot & Readonly<{ chunks: readonly TerminalChunk[]; truncated: boolean }>;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new RunnerError('invalid_input');
  return value as Record<string, unknown>;
}
export function terminalSize(value: unknown): TerminalSize {
  const input = record(value, ['cols', 'rows']);
  if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || Number(input.cols) < 2 || Number(input.cols) > 500 || Number(input.rows) < 1 || Number(input.rows) > 300) throw new RunnerError('invalid_input');
  return { cols: Number(input.cols), rows: Number(input.rows) };
}
export function terminalOpen(value: unknown): TerminalSize & Readonly<{ taskId?: string }> {
  const input = record(value, ['cols', 'rows', 'taskId']);
  if (input.taskId !== undefined && !isId(input.taskId)) throw new RunnerError('invalid_input');
  return { ...terminalSize({ cols: input.cols, rows: input.rows }), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) };
}
export function terminalInput(value: unknown): string {
  const { data } = record(value, ['data']);
  if (typeof data !== 'string' || data.length === 0 || new TextEncoder().encode(data).length > TERMINAL_LIMITS.inputBytes) throw new RunnerError('invalid_input');
  return data;
}
