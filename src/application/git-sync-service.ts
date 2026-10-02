import { randomUUID } from 'node:crypto';
import { isId, RunnerError } from '../domain/contracts.js';
import type { RegisteredProject } from '../domain/execution.js';
import {
  GIT_SYNC_LIMITS, isGitErrorCode, parseCommitInput, parseIdempotencyInput, parsePushInput, threadBranchName,
  validGitBranchName, validProjectId,
  type BranchList, type CheckoutStatus, type CommitResult, type GitAuthor, type GitErrorCode, type GitOperation,
  type GitOperationKind, type GitOperationResult, type PushTarget, type ThreadGitStatus,
} from '../domain/git-sync.js';
import { isBranchList, isCheckoutStatus, isCommitResult, isGitOperation, isThreadGitStatus } from '../domain/git-sync-wire.js';
import { gitLeaseKey, type GitCoordination } from './git-coordination.js';
import type {
  GitActivity, GitRepository, GitSyncApplication, GitWorkdir, GitWorkspaces, ManagedInstructionPaths, OriginBaseResolver,
  RepositoryStatus, ThreadWorkspace,
} from './git-sync-ports.js';
import type { ProjectRegistry } from './execution-ports.js';
import type { TaskRepository } from './ports.js';

export type GitSyncTasks = Pick<TaskRepository, 'getTask'> & Readonly<{
  getTaskSession(taskId: string): Promise<Readonly<{ workspaceTaskId: string }>>;
}>;
export type GitSyncOptions = Readonly<{
  author?: GitAuthor;
  updateMs?: number;
  mergeReserveMs?: number;
  localRequestMs?: number;
  retainedOperations?: number;
  retentionMs?: number;
  now?: () => number;
}>;

type StoredOperation = {
  view: GitOperation;
  key: string;
  fingerprint: string;
  completedAt?: number;
};
type ThreadContext = Readonly<{ project: RegisteredProject; workspaceTaskId: string; thread: ThreadWorkspace; leaseKey: string }>;

export class GitOriginBases implements OriginBaseResolver {
  constructor(private readonly coordination: GitCoordination, private readonly repository: GitRepository) {}

  resolveOriginBase(project: RegisteredProject, workdir: GitWorkdir, branch: string, signal?: AbortSignal) {
    if (!validGitBranchName(branch)) throw new RunnerError('invalid_input');
    return this.coordination.withProject(project.id, signal, async () => {
      const { fetchedAt } = await this.coordination.fetchHeld(project.id, signal, fetchSignal => this.repository.fetch(workdir, fetchSignal));
      const sha = await this.repository.resolve(workdir, `refs/remotes/origin/${branch}`, signal);
      if (!sha) throw new RunnerError('git_branch_not_found');
      return { sha, fetchedAt };
    });
  }
}

export class GitSyncService implements GitSyncApplication {
  private readonly operations = new Map<string, StoredOperation>();
  private readonly keys = new Map<string, string>();
  private readonly running = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private readonly updateMs: number;
  private readonly mergeReserveMs: number;
  private readonly localRequestMs: number;
  private readonly retainedOperations: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(
    private readonly tasks: GitSyncTasks,
    private readonly activity: GitActivity,
    private readonly registry: ProjectRegistry,
    private readonly workspaces: GitWorkspaces,
    private readonly repository: GitRepository,
    private readonly coordination: GitCoordination,
    private readonly options: GitSyncOptions = {},
    private readonly instructions?: ManagedInstructionPaths,
  ) {
    this.updateMs = options.updateMs ?? GIT_SYNC_LIMITS.updateMs;
    this.mergeReserveMs = options.mergeReserveMs ?? GIT_SYNC_LIMITS.localMs;
    this.localRequestMs = options.localRequestMs ?? 25_000;
    this.retainedOperations = options.retainedOperations ?? GIT_SYNC_LIMITS.retainedOperations;
    this.retentionMs = options.retentionMs ?? GIT_SYNC_LIMITS.operationRetentionMs;
    this.now = options.now ?? Date.now;
  }

  branches(projectId: string): Promise<BranchList> {
    return this.request(async signal => {
      const project = await this.project(projectId);
      const workdir = await this.checkout(project, signal);
      const branches = await this.repository.branches(workdir, signal);
      return verified({ ...branches, fetchedAt: this.coordination.fetchedAt(project.id) }, isBranchList);
    });
  }

  projectStatus(projectId: string): Promise<CheckoutStatus> {
    return this.request(async signal => {
      const project = await this.project(projectId);
      const workdir = await this.checkout(project, signal);
      const status = await this.repository.status(workdir, await this.managed(null, workdir, 'in-place', signal), signal);
      return verified({ ...status, inPlaceTaskActive: await this.activity.inPlaceActive(project.id),
        fetchedAt: this.coordination.fetchedAt(project.id) }, isCheckoutStatus);
    });
  }

  async fetch(projectId: string, input: unknown): Promise<GitOperation> {
    this.assertOpen();
    if (!validProjectId(projectId)) throw new RunnerError('invalid_input');
    const { idempotencyKey } = parseIdempotencyInput(input);
    const fingerprint = `fetch:${projectId}`;
    const replay = this.replay(idempotencyKey, fingerprint);
    if (replay) return replay;
    const project = await this.project(projectId);
    return this.admit('fetch', idempotencyKey, fingerprint, async signal => {
      const workdir = await this.checkout(project, signal);
      const { fetchedAt } = await this.coordination.fetch(project.id, signal, fetchSignal => this.repository.fetch(workdir, fetchSignal));
      return { kind: 'fetch', fetchedAt };
    });
  }

  async update(projectId: string, input: unknown): Promise<GitOperation> {
    this.assertOpen();
    if (!validProjectId(projectId)) throw new RunnerError('invalid_input');
    const { idempotencyKey } = parseIdempotencyInput(input);
    const fingerprint = `update:${projectId}`;
    const replay = this.replay(idempotencyKey, fingerprint);
    if (replay) return replay;
    const project = await this.project(projectId);
    await this.request(async signal => this.updatable(project, await this.checkout(project, signal), signal));
    return this.admit('update', idempotencyKey, fingerprint, signal =>
      this.coordination.withWorkspace(gitLeaseKey('in-place', project.id, ''), signal, () =>
        this.coordination.withProject(project.id, signal, async () => {
          const started = this.now();
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.updateMs)]);
          const workdir = await this.checkout(project, deadline);
          await this.updatable(project, workdir, deadline);
          await this.coordination.fetchHeld(project.id, deadline, fetchSignal => this.repository.fetch(workdir, fetchSignal), false);
          const status = await this.updatable(project, workdir, deadline);
          if (status.ahead > 0 && status.behind > 0) throw new RunnerError('git_diverged');
          if (status.behind === 0) return { kind: 'update', headSha: status.headSha, fastForwarded: 0 };
          if (deadline.aborted || this.now() - started > this.updateMs - this.mergeReserveMs) throw new RunnerError('git_timeout');
          const headSha = await this.repository.fastForward(workdir, signal);
          return { kind: 'update', headSha, fastForwarded: status.behind };
        })));
  }

  threadStatus(taskId: string): Promise<ThreadGitStatus> {
    return this.request(async signal => this.threadGitStatus(await this.thread(taskId, signal), signal));
  }

  async commit(taskId: string, input: unknown): Promise<CommitResult> {
    this.assertOpen();
    const { message } = parseCommitInput(input);
    return this.request(async signal => {
      const context = await this.thread(taskId, signal);
      return this.coordination.withWorkspace(context.leaseKey, signal, async () => {
        if (await this.active(context)) throw new RunnerError('busy');
        const workdir = context.thread.workdir;
        const excluded = await this.managed(context.workspaceTaskId, workdir, context.thread.mode, signal);
        const status = await this.repository.status(workdir, excluded, signal);
        if (status.operation !== 'none') throw new RunnerError('git_operation_in_progress');
        const author = this.options.author ?? await this.repository.localAuthor(workdir, signal);
        if (!author) throw new RunnerError('git_identity_missing');
        const commitSha = await this.repository.commit(workdir, message, author, excluded, signal);
        return verified({ commitSha, status: await this.threadGitStatus(context, signal) }, isCommitResult);
      }, 10_000);
    });
  }

  async push(taskId: string, input: unknown): Promise<GitOperation> {
    this.assertOpen();
    const { idempotencyKey, target } = parsePushInput(input);
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    const fingerprint = `push:${taskId}:${target}`;
    const replay = this.replay(idempotencyKey, fingerprint);
    if (replay) return replay;
    const { context, branch } = await this.request(async signal => {
      const context = await this.thread(taskId, signal);
      if (await this.active(context)) throw new RunnerError('busy');
      return { context, branch: await this.pushBranch(context, target, signal) };
    });
    return this.admit('push', idempotencyKey, fingerprint, signal =>
      this.coordination.withWorkspace(context.leaseKey, signal, async () => {
        if (await this.active(context)) throw new RunnerError('busy');
        return this.coordination.withProject(context.project.id, signal, () => this.coordination.withNetwork(signal, async () => {
          const workdir = context.thread.workdir;
          const sha = await this.repository.resolve(workdir, 'HEAD', signal);
          if (!sha) throw new RunnerError('conflict');
          const { created } = await this.repository.push(workdir, sha, branch, signal);
          return { kind: 'push', remoteRef: `refs/heads/${branch}`, pushedSha: sha, created };
        }));
      }));
  }

  async operation(id: string): Promise<GitOperation> {
    if (!isId(id)) throw new RunnerError('invalid_input');
    this.expire();
    const stored = this.operations.get(id);
    if (!stored) throw new RunnerError('not_found');
    return stored.view;
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.running]);
  }

  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new RunnerError('busy');
  }

  private async request<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    const deadline = AbortSignal.timeout(this.localRequestMs);
    try { return await action(AbortSignal.any([this.lifetime.signal, deadline])); }
    catch (error) {
      if (error instanceof RunnerError) throw error;
      if (deadline.aborted) throw new RunnerError('git_timeout');
      if (this.lifetime.signal.aborted) throw new RunnerError('busy');
      throw new RunnerError('conflict');
    }
  }

  private managed(workspaceTaskId: string | null, workdir: GitWorkdir, mode: 'worktree' | 'in-place', signal: AbortSignal): Promise<readonly string[]> {
    return guarded(async () => this.instructions?.managedPaths(workspaceTaskId, workdir.cwd, mode) ?? [], signal);
  }

  private async project(projectId: string): Promise<RegisteredProject> {
    if (!validProjectId(projectId)) throw new RunnerError('invalid_input');
    return this.registry.get(projectId);
  }

  private async checkout(project: RegisteredProject, signal: AbortSignal): Promise<GitWorkdir> {
    return guarded(() => this.workspaces.checkout(project, signal), signal);
  }

  private async thread(taskId: string, signal: AbortSignal): Promise<ThreadContext> {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    const task = await this.tasks.getTask(taskId);
    if (!task.projectId) throw new RunnerError('conflict');
    const project = await this.registry.get(task.projectId);
    const { workspaceTaskId } = await this.tasks.getTaskSession(taskId);
    const thread = await guarded(() => this.workspaces.thread(project, workspaceTaskId, signal), signal);
    return { project, workspaceTaskId, thread, leaseKey: gitLeaseKey(thread.mode, project.id, workspaceTaskId) };
  }

  private async active(context: ThreadContext): Promise<boolean> {
    if (await this.activity.conversationActive(context.workspaceTaskId)) return true;
    return context.thread.mode === 'in-place' && this.activity.inPlaceActive(context.project.id);
  }

  private async updatable(project: RegisteredProject, workdir: GitWorkdir, signal: AbortSignal) {
    if (await this.activity.inPlaceActive(project.id)) throw new RunnerError('busy');
    const status = await this.repository.status(workdir, await this.managed(null, workdir, 'in-place', signal), signal);
    if (!status.branch) throw new RunnerError('git_detached_head');
    if (status.operation !== 'none') throw new RunnerError('git_operation_in_progress');
    if (!status.upstream || !status.upstream.ref.startsWith('origin/')) throw new RunnerError('git_no_upstream');
    if (status.dirty.tracked > 0 || status.dirty.truncated) throw new RunnerError('git_dirty');
    return { headSha: status.headSha, ahead: status.upstream.ahead, behind: status.upstream.behind };
  }

  private async pushBranch(context: ThreadContext, target: PushTarget, signal: AbortSignal): Promise<string> {
    const { record, mode, workdir } = context.thread;
    if (target === 'base-branch') {
      if (mode !== 'worktree' || !record) throw new RunnerError('conflict');
      return record.baseBranch;
    }
    if (record) return record.threadBranch;
    if (mode === 'worktree') return threadBranchName(context.workspaceTaskId);
    const status = await this.repository.status(workdir, [], signal);
    if (!status.branch) throw new RunnerError('git_detached_head');
    return status.branch;
  }

  private publishBranch(context: ThreadContext, status: RepositoryStatus): string | null {
    const { record, mode } = context.thread;
    if (record) return record.threadBranch;
    return mode === 'worktree' ? threadBranchName(context.workspaceTaskId) : status.branch;
  }

  private async threadGitStatus(context: ThreadContext, signal: AbortSignal): Promise<ThreadGitStatus> {
    const { thread, project } = context;
    const status = await this.repository.status(thread.workdir, await this.managed(context.workspaceTaskId, thread.workdir, thread.mode, signal), signal);
    const publishBranch = this.publishBranch(context, status);
    const [base, published, active] = await Promise.all([
      thread.record ? this.tracking(thread.workdir, status.headSha, thread.record.baseBranch, signal) : null,
      publishBranch ? this.tracking(thread.workdir, status.headSha, publishBranch, signal) : null,
      this.active(context),
    ]);
    const record = thread.record;
    return verified({
      mode: thread.mode, branch: status.branch, headSha: status.headSha,
      base: record ? {
        branch: record.baseBranch, sha: base?.sha ?? record.baseSha,
        fetchedAt: this.coordination.fetchedAt(project.id) ?? record.fetchedAt,
        ...(base ?? await this.repository.divergence(thread.workdir, status.headSha, record.baseSha, signal)),
      } : null,
      published: publishBranch && published ? { ref: `origin/${publishBranch}`, ahead: published.ahead, behind: published.behind } : null,
      dirty: status.dirty, active,
    }, isThreadGitStatus);
  }

  private async tracking(workdir: GitWorkdir, headSha: string, branch: string, signal: AbortSignal) {
    const sha = await this.repository.resolve(workdir, `refs/remotes/origin/${branch}`, signal);
    return sha ? { sha, ...await this.repository.divergence(workdir, headSha, sha, signal) } : null;
  }

  private replay(idempotencyKey: string, fingerprint: string): GitOperation | undefined {
    this.expire();
    const id = this.keys.get(idempotencyKey);
    const stored = id === undefined ? undefined : this.operations.get(id);
    if (!stored) return undefined;
    if (stored.fingerprint !== fingerprint) throw new RunnerError('conflict');
    return stored.view;
  }

  private admit(kind: GitOperationKind, idempotencyKey: string, fingerprint: string,
    job: (signal: AbortSignal) => Promise<GitOperationResult>): GitOperation {
    this.assertOpen();
    const replay = this.replay(idempotencyKey, fingerprint);
    if (replay) return replay;
    if (this.operations.size >= this.retainedOperations) {
      const oldest = [...this.operations.entries()].find(([, stored]) => stored.completedAt !== undefined);
      if (!oldest) throw new RunnerError('busy');
      this.forget(oldest[0]);
    }
    const id = randomUUID();
    const stored: StoredOperation = { key: idempotencyKey, fingerprint, view: { id, kind, status: 'running', error: null, result: null } };
    this.operations.set(id, stored);
    this.keys.set(idempotencyKey, id);
    const execute = async () => {
      try {
        const result = await job(this.lifetime.signal);
        stored.view = verified({ id, kind, status: 'succeeded', error: null, result }, isGitOperation);
      } catch (error) {
        stored.view = { id, kind, status: 'failed', error: failureCode(error), result: null };
      } finally {
        stored.completedAt = this.now();
      }
    };
    const completion = execute().finally(() => this.running.delete(completion));
    this.running.add(completion);
    return stored.view;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, stored] of this.operations)
      if (stored.completedAt !== undefined && now - stored.completedAt >= this.retentionMs) this.forget(id);
  }

  private forget(id: string): void {
    const stored = this.operations.get(id);
    this.operations.delete(id);
    if (stored && this.keys.get(stored.key) === id) this.keys.delete(stored.key);
  }
}

function verified<T>(value: T, check: (value: unknown) => boolean): T {
  if (!check(value)) throw new RunnerError('conflict');
  return value;
}

async function guarded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof RunnerError || signal.aborted) throw error;
    throw new RunnerError('conflict');
  }
}

function failureCode(error: unknown): GitErrorCode {
  if (error instanceof RunnerError && isGitErrorCode(error.code)) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'git_timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'busy';
  return 'conflict';
}
