import { RunnerError } from './contracts.js';
export type HistorySearchQuery = Readonly<{ q: string; after: number; projectId?: string }>;
export type HistorySearchMatch = Readonly<{ taskId: string; conversationId: string; projectId: string | null; taskSequence: number; role: 'user' | 'assistant'; eventSequence: number | null; snippet: string }>;
export type HistorySearchPage = Readonly<{ items: readonly HistorySearchMatch[]; nextCursor: number | null; scope: 'retained_runner_history'; incomplete: boolean }>;
export function parseHistorySearch(value: unknown): HistorySearchQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['q', 'after', 'projectId'].includes(key))) throw new RunnerError('invalid_input');
  if (typeof v.q !== 'string' || v.q.trim().length < 2 || v.q.length > 256 || new TextEncoder().encode(v.q).length > 1024 || /[\u0000-\u001f]/u.test(v.q)) throw new RunnerError('invalid_input');
  if (!Number.isSafeInteger(v.after) || (v.after as number) < 0) throw new RunnerError('invalid_input');
  if (v.projectId !== undefined && (typeof v.projectId !== 'string' || !v.projectId.length || v.projectId.length > 128 || /[\u0000-\u001f]/u.test(v.projectId))) throw new RunnerError('invalid_input');
  return { q: v.q.trim(), after: v.after as number, ...(v.projectId === undefined ? {} : { projectId: v.projectId as string }) };
}
