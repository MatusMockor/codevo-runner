import type { AgentSubagentLifecycle } from './subagent-lifecycle.js';
import type { InstructionSnapshot } from './instructions.js';
import type { AgentLaunchOptions } from './launch.js';
import type { TaskStatus } from './execution.js';

export const LIMITS = Object.freeze({
  jsonBytes: 4 * 1024 * 1024, textBytes: 48_000, parts: 16, attachmentsPerTask: 8,
  attachmentBytes: 8 * 1024 * 1024, textAttachmentBytes: 5 * 1024 * 1024, imagePixels: 16_000_000, imageDimension: 8192,
  attachments: 256, storageBytes: 256 * 1024 * 1024,
  pageSize: 50, uploads: 2, uploadTimeoutMs: 30_000,
});
export type MediaType = 'image/png' | 'image/jpeg' | 'text/plain';
export type MessagePart = Readonly<{ type: 'text'; text: string }> |
  Readonly<{ type: 'attachment'; attachmentId: string }>;
export type TaskIsolation = 'in-place' | 'worktree';
export type CreateTask = Readonly<{
  isolation?: TaskIsolation;
  instructions?: InstructionSnapshot; idempotencyKey: string; provider: 'codex' | 'claude'; launch?: AgentLaunchOptions; parts: readonly MessagePart[];
}>;
export type Task = Readonly<{
  isolation?: TaskIsolation;
  instructions?: InstructionSnapshot; id: string; sequence: number; runnerId: string; provider: 'codex' | 'claude';
  launch?: AgentLaunchOptions; status: TaskStatus; projectId?: string; conversationId?: string; parentTaskId?: string; parts: readonly MessagePart[]; createdAt: string;
}>;
export type Attachment = Readonly<{
  id: string; runnerId: string; name: string; bytes: number;
  sha256: string; createdAt: string;
}> & (Readonly<{ mediaType: 'image/png' | 'image/jpeg'; width: number; height: number }> | Readonly<{ mediaType: 'text/plain'; width?: never; height?: never }>);
export type TaskEvent = Readonly<{
  sequence: number; taskId: string; type: 'task.created' | 'task.cancelled' | 'task.queued' | 'task.running' | 'task.succeeded' | 'task.failed' | 'task.interrupted' | 'task.output' | 'task.input'; createdAt: string;
  messageId?: string; parts?: readonly MessagePart[];
  channel?: 'stdout' | 'stderr'; text?: string; exitCode?: number | null; error?: string;
}>;
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: number | null }>;
export type EventPage = Page<TaskEvent> & Readonly<{ subagentLifecycle?: AgentSubagentLifecycle; outputTruncatedBeforeSequence?: number; outputStartsAtLineBoundary?: boolean }>;
export type ErrorCode = 'delivery_uncertain' | 'invalid_input' | 'not_found' | 'conflict' | 'quota_exceeded' |
  'unsupported_media' | 'too_large' | 'busy' | 'storage_unavailable' |
  'git_remote_unavailable' | 'git_auth_failed' | 'git_timeout' | 'git_no_remote' | 'git_remote_unsupported' |
  'git_branch_not_found' | 'git_detached_head' | 'git_no_upstream' | 'git_dirty' | 'git_diverged' |
  'git_operation_in_progress' | 'git_rejected_non_fast_forward' | 'git_rejected' | 'git_nothing_to_commit' |
  'git_identity_missing';
export class RunnerError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'RunnerError'; }
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
