import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { GitRepository, GitWorkdir, PushResult, RemoteBranches, RepositoryStatus } from '../../application/git-sync-ports.js';
import { RunnerError } from '../../domain/contracts.js';
import {
  classifyNetworkFailure, classifyPushPorcelain, GIT_SYNC_LIMITS, validGitAuthorPart, validGitBranchName, validGitSha,
  type CheckoutOperation, type DirtySummary, type GitAuthor, type RemoteBranch,
} from '../../domain/git-sync.js';
import { isWireTimestamp } from '../../domain/git-sync-wire.js';
import { GLOBAL_INSTRUCTIONS_ROOT, GLOBAL_RULES_ROOT } from '../../domain/instruction-context.js';
import { localGit, networkGit, readOrigin } from './git-network.js';

export type GitRepositoryTimeouts = Readonly<{ fetchMs?: number; pushMs?: number; localMs?: number }>;

const BRANCH_SCAN = 1001;
const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const OPERATIONS: readonly (readonly [string, CheckoutOperation])[] = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
];

export class GitRepositoryAdapter implements GitRepository {
  private readonly fetchMs: number;
  private readonly pushMs: number;
  private readonly localMs: number;

  constructor(timeouts: GitRepositoryTimeouts = {}) {
    this.fetchMs = timeouts.fetchMs ?? GIT_SYNC_LIMITS.fetchMs;
    this.pushMs = timeouts.pushMs ?? GIT_SYNC_LIMITS.pushMs;
    this.localMs = timeouts.localMs ?? GIT_SYNC_LIMITS.localMs;
  }

  async fetch(workdir: GitWorkdir, signal?: AbortSignal): Promise<void> {
    const origin = await readOrigin(workdir, signal);
    const result = await networkGit(workdir, origin.fetchUrl,
      ['fetch', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet', '--', origin.fetchUrl, FETCH_REFSPEC],
      this.fetchMs, signal);
    if (result.code !== 0) throw new RunnerError(classifyNetworkFailure(result.stderr));
  }

  async branches(workdir: GitWorkdir, signal?: AbortSignal): Promise<RemoteBranches> {
    const refs = await this.local(workdir, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_SCAN}`,
      '--format=%(refname:strip=3)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/remotes/origin/'], signal);
    if (refs.code !== 0) throw new RunnerError('conflict');
    const lines = refs.stdout.toString('utf8').split('\n');
    if (refs.truncated) lines.pop();
    const branches: RemoteBranch[] = [];
    let scanned = 0;
    for (const line of lines) {
      if (!line) continue;
      scanned++;
      const [name, sha, committedAt, extra] = line.split('\0');
      if (extra !== undefined || !validGitBranchName(name) || !validGitSha(sha) || !isWireTimestamp(committedAt)) continue;
      branches.push({ name, sha, committedAt: committedAt as string });
    }
    const truncated = refs.truncated || scanned >= BRANCH_SCAN || branches.length > GIT_SYNC_LIMITS.branches;
    return {
      defaultBranch: await this.symbolicBranch(workdir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 'refs/remotes/origin/', signal),
      checkoutBranch: await this.symbolicBranch(workdir, ['symbolic-ref', '--quiet', 'HEAD'], 'refs/heads/', signal),
      branches: branches.slice(0, GIT_SYNC_LIMITS.branches),
      truncated,
    };
  }

  async status(workdir: GitWorkdir, excluded: readonly string[], signal?: AbortSignal): Promise<RepositoryStatus> {
    const [result, operation] = await Promise.all([
      this.local(workdir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--', '.', ...exclusions(excluded)], signal),
      this.operation(workdir, signal),
    ]);
    if (result.code !== 0) throw new RunnerError('conflict');
    return { ...parseStatus(result.stdout.toString('utf8'), result.truncated), operation };
  }

  async resolve(workdir: GitWorkdir, ref: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.local(workdir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], signal);
    const sha = result.stdout.toString('utf8').trim();
    if (result.code !== 0) return null;
    if (!validGitSha(sha)) throw new RunnerError('conflict');
    return sha;
  }

  async divergence(workdir: GitWorkdir, left: string, right: string, signal?: AbortSignal) {
    if (!validGitSha(left) || !validGitSha(right)) throw new RunnerError('invalid_input');
    const result = await this.local(workdir, ['rev-list', '--left-right', '--count', `${left}...${right}`], signal);
    const match = /^(\d+)\t(\d+)\n?$/.exec(result.stdout.toString('utf8'));
    if (result.code !== 0 || !match) throw new RunnerError('conflict');
    return { ahead: Number(match[1]), behind: Number(match[2]) };
  }

  async fastForward(workdir: GitWorkdir, signal?: AbortSignal): Promise<string> {
    const result = await this.local(workdir, ['merge', '--ff-only', '--no-edit', '--no-stat', '--quiet', '@{upstream}'], signal, true);
    if (result.code !== 0) {
      if (/untracked working tree files would be|local changes to the following files would be|would be overwritten/i.test(result.stderr))
        throw new RunnerError('git_dirty');
      if (/not possible to fast-forward|diverging branches|not a fast-forward/i.test(result.stderr)) throw new RunnerError('git_diverged');
      throw new RunnerError('conflict');
    }
    const head = await this.resolve(workdir, 'HEAD', signal);
    if (!head) throw new RunnerError('conflict');
    return head;
  }

  async localAuthor(workdir: GitWorkdir, signal?: AbortSignal): Promise<GitAuthor | null> {
    const read = async (key: string) => {
      const result = await this.local(workdir, ['config', '--local', '--no-includes', '--get', key], signal);
      const value = result.stdout.toString('utf8').replace(/\n$/, '');
      return result.code === 0 && !result.truncated && validGitAuthorPart(value) ? value : null;
    };
    const name = await read('user.name');
    const email = await read('user.email');
    return name && email ? { name, email } : null;
  }

  async commit(workdir: GitWorkdir, message: string, author: GitAuthor, excluded: readonly string[], signal?: AbortSignal): Promise<string> {
    if (!validGitAuthorPart(author.name) || !validGitAuthorPart(author.email)) throw new RunnerError('git_identity_missing');
    const added = await this.local(workdir, ['add', '--all', '--', '.', ...exclusions(excluded)], signal);
    if (added.code !== 0) throw new RunnerError('conflict');
    const staged = await this.local(workdir, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv'], signal);
    if (staged.code === 0) throw new RunnerError('git_nothing_to_commit');
    if (staged.code !== 1) throw new RunnerError('conflict');
    const committed = await this.local(workdir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
      'commit', '--no-verify', '--quiet', '--no-edit', '--cleanup=whitespace', '-m', message], signal);
    if (committed.code !== 0) throw new RunnerError('conflict');
    const head = await this.resolve(workdir, 'HEAD', signal);
    if (!head) throw new RunnerError('conflict');
    return head;
  }

  async push(workdir: GitWorkdir, sha: string, branch: string, signal?: AbortSignal): Promise<PushResult> {
    if (!validGitSha(sha) || !validGitBranchName(branch)) throw new RunnerError('invalid_input');
    const origin = await readOrigin(workdir, signal);
    const remoteRef = `refs/heads/${branch}`;
    const result = await networkGit(workdir, origin.pushUrl,
      ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--no-recurse-submodules', '--', origin.pushUrl, `${sha}:${remoteRef}`],
      this.pushMs, signal);
    const outcome = classifyPushPorcelain(result.stdout.toString('utf8'), remoteRef);
    if (outcome?.status === 'rejected') throw new RunnerError(outcome.error);
    if (result.code !== 0 || !outcome) throw new RunnerError(classifyNetworkFailure(result.stderr));
    await this.local(workdir, ['update-ref', '-m', 'codevo: push', '--', `refs/remotes/origin/${branch}`, sha], signal).catch(() => undefined);
    return { created: outcome.status === 'created' };
  }

  private local(workdir: GitWorkdir, args: readonly string[], signal?: AbortSignal, withStderr = false) {
    return localGit(workdir, args, signal, this.localMs, withStderr ? GIT_SYNC_LIMITS.stderrBytes : 0);
  }

  private async symbolicBranch(workdir: GitWorkdir, args: readonly string[], prefix: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.local(workdir, args, signal);
    const ref = result.stdout.toString('utf8').trim();
    if (result.code !== 0 || !ref.startsWith(prefix)) return null;
    const name = ref.slice(prefix.length);
    return validGitBranchName(name) ? name : null;
  }

  private async operation(workdir: GitWorkdir, signal?: AbortSignal): Promise<CheckoutOperation> {
    const result = await this.local(workdir, ['rev-parse', '--absolute-git-dir'], signal);
    const gitDir = result.stdout.toString('utf8').replace(/\n$/, '');
    if (result.code !== 0 || result.truncated || !isAbsolute(gitDir)) throw new RunnerError('conflict');
    for (const [file, operation] of OPERATIONS) {
      try { await lstat(join(gitDir, file)); return operation; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new RunnerError('conflict');
      }
    }
    return 'none';
  }
}

function exclusions(excluded: readonly string[]): readonly string[] {
  return [GLOBAL_INSTRUCTIONS_ROOT, GLOBAL_RULES_ROOT, ...excluded].map(path => `:(top,literal,exclude)${path}`);
}

export function parseStatus(text: string, truncatedOutput: boolean): Omit<RepositoryStatus, 'operation'> {
  const fields = text.split('\0');
  if (truncatedOutput || fields.at(-1) !== '') fields.pop();
  let headSha: string | undefined;
  let branch: string | null = null;
  let upstreamRef: string | null = null;
  let ahead: number | undefined;
  let behind: number | undefined;
  let tracked = 0;
  let untracked = 0;
  let truncated = truncatedOutput;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.startsWith('# branch.oid ')) headSha = field.slice('# branch.oid '.length);
    else if (field.startsWith('# branch.head ')) {
      const name = field.slice('# branch.head '.length);
      branch = name !== '(detached)' && validGitBranchName(name) ? name : null;
    } else if (field.startsWith('# branch.upstream ')) {
      const name = field.slice('# branch.upstream '.length);
      upstreamRef = validGitBranchName(name) ? name : null;
    } else if (field.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (field.startsWith('1 ') || field.startsWith('u ')) tracked++;
    else if (field.startsWith('2 ')) { tracked++; index++; }
    else if (field.startsWith('? ')) untracked++;
  }
  if (!validGitSha(headSha)) throw new RunnerError('conflict');
  const limit = GIT_SYNC_LIMITS.dirtyCount;
  if (tracked > limit || untracked > limit) truncated = true;
  const dirty: DirtySummary = { tracked: Math.min(tracked, limit), untracked: Math.min(untracked, limit), truncated };
  const upstream = upstreamRef && ahead !== undefined && behind !== undefined && Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)
    ? { ref: upstreamRef, ahead, behind } : null;
  return { branch, headSha, upstream, dirty };
}
