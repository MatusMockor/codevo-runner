import { isId, RunnerError, type ErrorCode } from './contracts.js';
import { validCloneBranch } from './project-clone.js';

export const GIT_ERROR_CODES = [
  'git_remote_unavailable', 'git_auth_failed', 'git_timeout', 'git_no_remote',
  'git_remote_unsupported', 'git_branch_not_found', 'git_detached_head',
  'git_no_upstream', 'git_dirty', 'git_diverged', 'git_operation_in_progress',
  'git_rejected_non_fast_forward', 'git_rejected', 'git_nothing_to_commit',
  'git_identity_missing', 'busy', 'conflict',
] as const;
export type GitErrorCode = (typeof GIT_ERROR_CODES)[number] & ErrorCode;

export const GIT_SYNC_LIMITS = Object.freeze({
  branchBytes: 255, branches: 500, dirtyCount: 10_000, commitMessageBytes: 4096,
  identityBytes: 256, stderrBytes: 16 * 1024, retainedOperations: 64,
  operationRetentionMs: 10 * 60_000, fetchCoalesceMs: 15_000,
  networkOperations: 2, leaseWaitMs: 130_000,
  fetchMs: 60_000, updateMs: 60_000, pushMs: 120_000, localMs: 10_000,
});

export type StartBase = Readonly<{ kind: 'origin-branch'; branch: string }> | Readonly<{ kind: 'checkout-head' }>;
export type StartInput = Readonly<{ projectId: string; base?: StartBase }>;
export type PushTarget = 'thread-branch' | 'base-branch';
export type GitOperationKind = 'fetch' | 'update' | 'push';
export type DirtySummary = Readonly<{ tracked: number; untracked: number; truncated: boolean }>;
export type Tracking = Readonly<{ ref: string; ahead: number; behind: number }>;
export type CheckoutOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
export type RemoteBranch = Readonly<{ name: string; sha: string; committedAt: string }>;
export type BranchList = Readonly<{
  defaultBranch: string | null; checkoutBranch: string | null; fetchedAt: string | null;
  branches: readonly RemoteBranch[]; truncated: boolean;
}>;
export type CheckoutStatus = Readonly<{
  branch: string | null; headSha: string; upstream: Tracking | null; dirty: DirtySummary;
  operation: CheckoutOperation; inPlaceTaskActive: boolean; fetchedAt: string | null;
}>;
export type ThreadGitBase = Readonly<{ branch: string; sha: string; fetchedAt: string | null; ahead: number; behind: number }>;
export type ThreadGitStatus = Readonly<{
  mode: 'worktree' | 'in-place'; branch: string | null; headSha: string; base: ThreadGitBase | null;
  published: Tracking | null; dirty: DirtySummary; active: boolean;
}>;
export type CommitResult = Readonly<{ commitSha: string; status: ThreadGitStatus }>;
export type GitOperationResult =
  | Readonly<{ kind: 'fetch'; fetchedAt: string }>
  | Readonly<{ kind: 'update'; headSha: string; fastForwarded: number }>
  | Readonly<{ kind: 'push'; remoteRef: string; pushedSha: string; created: boolean }>;
export type WorkspaceGitRecord = Readonly<{
  version: 1; baseBranch: string; baseSha: string; threadBranch: string; fetchedAt: string | null;
}>;
export type GitAuthor = Readonly<{ name: string; email: string }>;
export type GitOperation = Readonly<{
  id: string; kind: GitOperationKind; status: 'running' | 'succeeded' | 'failed';
  error: GitErrorCode | null; result: GitOperationResult | null;
}>;

const COMMIT_FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isGitErrorCode(value: unknown): value is GitErrorCode {
  return typeof value === 'string' && (GIT_ERROR_CODES as readonly string[]).includes(value);
}

export function validGitBranchName(value: unknown): value is string {
  return validCloneBranch(value) && value !== 'HEAD' && !value.startsWith('+') &&
    !LONE_SURROGATE.test(value) && Buffer.byteLength(value) <= GIT_SYNC_LIMITS.branchBytes;
}

export function validGitSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

export function validCommitMessage(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !LONE_SURROGATE.test(value) &&
    !COMMIT_FORBIDDEN.test(value) && Buffer.byteLength(value) <= GIT_SYNC_LIMITS.commitMessageBytes;
}

export function validGitAuthorPart(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value) &&
    !LONE_SURROGATE.test(value) && Buffer.byteLength(value) <= GIT_SYNC_LIMITS.identityBytes;
}

export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value);
}

export function threadBranchName(rootTaskId: string, full = false): string {
  if (!isId(rootTaskId)) throw new RunnerError('invalid_input');
  const hex = rootTaskId.replaceAll('-', '');
  return `codevo/${full ? hex : hex.slice(0, 8)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in value)))
    throw new RunnerError('invalid_input');
}

export function parseStartBase(value: unknown): StartBase {
  const base = record(value);
  if (base.kind === 'checkout-head') {
    exactKeys(base, ['kind']);
    return { kind: 'checkout-head' };
  }
  if (base.kind !== 'origin-branch') throw new RunnerError('invalid_input');
  exactKeys(base, ['kind', 'branch']);
  if (!validGitBranchName(base.branch)) throw new RunnerError('invalid_input');
  return { kind: 'origin-branch', branch: base.branch };
}

export function parseStartInput(value: unknown): StartInput {
  const input = record(value);
  exactKeys(input, ['projectId'], ['base']);
  if (!validProjectId(input.projectId)) throw new RunnerError('invalid_input');
  if (!('base' in input)) return { projectId: input.projectId };
  return { projectId: input.projectId, base: parseStartBase(input.base) };
}

export function parseIdempotencyInput(value: unknown): Readonly<{ idempotencyKey: string }> {
  const input = record(value);
  exactKeys(input, ['idempotencyKey']);
  if (!isId(input.idempotencyKey)) throw new RunnerError('invalid_input');
  return { idempotencyKey: input.idempotencyKey };
}

export function parseCommitInput(value: unknown): Readonly<{ message: string }> {
  const input = record(value);
  exactKeys(input, ['message']);
  if (!validCommitMessage(input.message)) throw new RunnerError('invalid_input');
  return { message: input.message };
}

export function parsePushInput(value: unknown): Readonly<{ idempotencyKey: string; target: PushTarget }> {
  const input = record(value);
  exactKeys(input, ['idempotencyKey', 'target']);
  if (!isId(input.idempotencyKey) || (input.target !== 'thread-branch' && input.target !== 'base-branch'))
    throw new RunnerError('invalid_input');
  return { idempotencyKey: input.idempotencyKey, target: input.target };
}

export function serializeStartBase(base: StartBase | undefined): string | null {
  return base === undefined ? null : JSON.stringify(base);
}

export function readStoredStartBase(value: unknown): StartBase | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 1024) throw new RunnerError('storage_unavailable');
  try { return parseStartBase(JSON.parse(value)); }
  catch { throw new RunnerError('storage_unavailable'); }
}

const AUTH_FAILURE = /permission denied|authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or password|access denied|host key verification failed|http basic|returned error: 40[13]|requested url returned error: 40[13]/i;
const REMOTE_UNAVAILABLE = /could not resolve|connection (refused|timed out|closed|reset)|network is unreachable|no route to host|unable to access|could not read from remote repository|repository not found|does not appear to be a git repository|unexpected disconnect|early eof|remote end hung up|kex_exchange|operation timed out/i;

export function classifyNetworkFailure(stderr: string): GitErrorCode {
  if (AUTH_FAILURE.test(stderr)) return 'git_auth_failed';
  if (REMOTE_UNAVAILABLE.test(stderr)) return 'git_remote_unavailable';
  return 'git_remote_unavailable';
}

export type PushOutcome = Readonly<{ status: 'created' | 'updated' | 'unchanged' } | { status: 'rejected'; error: GitErrorCode }>;

export function classifyPushPorcelain(stdout: string, remoteRef: string): PushOutcome | undefined {
  for (const line of stdout.split('\n')) {
    const match = /^([ +\-*=!])\t([^\t]*)\t(.*)$/.exec(line);
    if (!match || !match[2]!.endsWith(`:${remoteRef}`)) continue;
    const flag = match[1]!;
    const summary = match[3]!;
    if (flag === '*') return { status: 'created' };
    if (flag === ' ') return { status: 'updated' };
    if (flag === '=') return { status: 'unchanged' };
    if (flag === '!' && /non-fast-forward|fetch first|stale info/i.test(summary))
      return { status: 'rejected', error: 'git_rejected_non_fast_forward' };
    return { status: 'rejected', error: 'git_rejected' };
  }
  return undefined;
}
