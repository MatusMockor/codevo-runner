import { isId } from './contracts.js';
import { GIT_SYNC_LIMITS, isGitErrorCode, validGitBranchName, validGitSha } from './git-sync.js';

type Check = (value: unknown) => boolean;

const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export const isWireTimestamp: Check = value => typeof value === 'string' && value.length <= 64 && TIMESTAMP.test(value);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const exact = (fields: Readonly<Record<string, Check>>): Check => value =>
  isRecord(value) && Object.keys(value).every(key => Object.hasOwn(fields, key)) &&
  Object.entries(fields).every(([key, check]) => check(value[key]));
const nullable = (check: Check): Check => value => value === null || check(value);
const oneOf = (...values: readonly unknown[]): Check => value => values.includes(value);
const integer = (max = Number.MAX_SAFE_INTEGER): Check => value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const boolean: Check = value => typeof value === 'boolean';
const list = (check: Check, max: number): Check => value => Array.isArray(value) && value.length <= max && value.every(check);

const dirty = exact({ tracked: integer(GIT_SYNC_LIMITS.dirtyCount), untracked: integer(GIT_SYNC_LIMITS.dirtyCount), truncated: boolean });
const tracking = exact({ ref: validGitBranchName, ahead: integer(), behind: integer() });

export const isBranchList = exact({
  defaultBranch: nullable(validGitBranchName),
  checkoutBranch: nullable(validGitBranchName),
  fetchedAt: nullable(isWireTimestamp),
  branches: list(exact({ name: validGitBranchName, sha: validGitSha, committedAt: isWireTimestamp }), GIT_SYNC_LIMITS.branches),
  truncated: boolean,
});

export const isCheckoutStatus = exact({
  branch: nullable(validGitBranchName),
  headSha: validGitSha,
  upstream: nullable(tracking),
  dirty,
  operation: oneOf('none', 'merge', 'rebase', 'cherry-pick', 'revert', 'bisect'),
  inPlaceTaskActive: boolean,
  fetchedAt: nullable(isWireTimestamp),
});

export const isThreadGitStatus = exact({
  mode: oneOf('worktree', 'in-place'),
  branch: nullable(validGitBranchName),
  headSha: validGitSha,
  base: nullable(exact({ branch: validGitBranchName, sha: validGitSha, fetchedAt: nullable(isWireTimestamp), ahead: integer(), behind: integer() })),
  published: nullable(tracking),
  dirty,
  active: boolean,
});

export const isCommitResult = exact({ commitSha: validGitSha, status: isThreadGitStatus });

const publishedRef: Check = value => typeof value === 'string' && value.startsWith('refs/heads/') &&
  validGitBranchName(value.slice('refs/heads/'.length));

const results: Readonly<Record<string, Check>> = {
  fetch: exact({ kind: oneOf('fetch'), fetchedAt: isWireTimestamp }),
  update: exact({ kind: oneOf('update'), headSha: validGitSha, fastForwarded: integer() }),
  push: exact({ kind: oneOf('push'), remoteRef: publishedRef, pushedSha: validGitSha, created: boolean }),
};

export const isGitOperation: Check = value => {
  if (!exact({ id: isId, kind: oneOf('fetch', 'update', 'push'), status: oneOf('running', 'succeeded', 'failed'),
    error: nullable(isGitErrorCode), result: result => result === null || isRecord(result) })(value) || !isRecord(value)) return false;
  if (value.status === 'running') return value.error === null && value.result === null;
  if (value.status === 'failed') return value.error !== null && value.result === null;
  return value.error === null && results[value.kind as string]!(value.result);
};

export const isGitErrorBody = exact({ error: isGitErrorCode });
