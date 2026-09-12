export const LIMITS = Object.freeze({
  jsonBytes: 65_536, textBytes: 48_000, parts: 16, attachmentsPerTask: 8,
  attachmentBytes: 8 * 1024 * 1024, imagePixels: 16_000_000, imageDimension: 8192,
  attachments: 256, storageBytes: 256 * 1024 * 1024, tasks: 1000,
  pageSize: 50, uploads: 2, uploadTimeoutMs: 30_000,
});
export type MediaType = 'image/png' | 'image/jpeg';
export type MessagePart = Readonly<{ type: 'text'; text: string }> |
  Readonly<{ type: 'attachment'; attachmentId: string }>;
export type CreateTask = Readonly<{
  idempotencyKey: string; provider: 'codex' | 'claude'; parts: readonly MessagePart[];
}>;
export type Task = Readonly<{
  id: string; sequence: number; runnerId: string; provider: 'codex' | 'claude';
  status: 'draft' | 'cancelled'; parts: readonly MessagePart[]; createdAt: string;
}>;
export type Attachment = Readonly<{
  id: string; runnerId: string; name: string; mediaType: MediaType; bytes: number;
  sha256: string; width: number; height: number; createdAt: string;
}>;
export type TaskEvent = Readonly<{
  sequence: number; taskId: string; type: 'task.created' | 'task.cancelled'; createdAt: string;
}>;
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: number | null }>;
export type ErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'quota_exceeded' |
  'unsupported_media' | 'too_large' | 'busy' | 'storage_unavailable';
export class RunnerError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'RunnerError'; }
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
