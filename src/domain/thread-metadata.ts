import { RunnerError } from './contracts.js';

export type ThreadMetadata = Readonly<{
  taskId: string; revision: number; title: string | null;
  pinned: boolean; archived: boolean; removed: boolean;
  viewedAtEpochMs: number | null; snoozedUntil: number | null;
  settledAt: number | null; sortOrder: number | null;
}>;
export type ThreadMetadataPatch = Readonly<{ expectedRevision: number }> & Partial<Omit<ThreadMetadata, 'taskId' | 'revision'>>;
export type ThreadMetadataPage = Readonly<{ items: readonly ThreadMetadata[]; nextAfter: string | null }>;
const fields = ['expectedRevision', 'title', 'pinned', 'archived', 'removed', 'viewedAtEpochMs', 'snoozedUntil', 'settledAt', 'sortOrder'];
export function parseThreadMetadataPatch(value: unknown): ThreadMetadataPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key)) || Object.keys(input).length < 2 || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw new RunnerError('invalid_input');
  if ('title' in input && input.title !== null && (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 256 || /[\u0000-\u001f\u007f]/.test(input.title))) throw new RunnerError('invalid_input');
  for (const key of ['pinned', 'archived', 'removed']) if (key in input && typeof input[key] !== 'boolean') throw new RunnerError('invalid_input');
  for (const key of ['viewedAtEpochMs', 'snoozedUntil', 'settledAt']) if (key in input && input[key] !== null && (!Number.isSafeInteger(input[key]) || ((input[key] as number) < 0 || (input[key] as number) > 8.64e15))) throw new RunnerError('invalid_input');
  if ('sortOrder' in input && input.sortOrder !== null && (typeof input.sortOrder !== 'number' || !Number.isFinite(input.sortOrder) || Math.abs(input.sortOrder) > Number.MAX_SAFE_INTEGER)) throw new RunnerError('invalid_input');
  return input as ThreadMetadataPatch;
}
export function metadataTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new RunnerError('invalid_input');
  return value;
}
export function defaultThreadMetadata(taskId: string): ThreadMetadata {
  return { taskId, revision: 0, title: null, pinned: false, archived: false, removed: false, viewedAtEpochMs: null, snoozedUntil: null, settledAt: null, sortOrder: null };
}
export type ThreadOrder = Readonly<{ targetTaskId: string; placement: 'before' | 'after' }>;
export function parseThreadOrder(value: unknown): ThreadOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'targetTaskId') || !Object.hasOwn(input, 'placement') || !['before', 'after'].includes(input.placement as string)) throw new RunnerError('invalid_input');
  return { targetTaskId: metadataTaskId(input.targetTaskId), placement: input.placement as 'before' | 'after' };
}
export function threadSection(value: ThreadMetadata, now: number): string {
  if (value.archived) return 'archived';
  if (value.settledAt !== null) return 'settled';
  if (value.snoozedUntil !== null && value.snoozedUntil > now) return 'snoozed';
  return value.pinned ? 'pinned' : 'active';
}
