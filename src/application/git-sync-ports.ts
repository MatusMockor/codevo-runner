import type { RegisteredProject } from '../domain/execution.js';
import type {
  BranchList, CheckoutOperation, CheckoutStatus, CommitResult, DirtySummary, GitAuthor, GitOperation,
  ThreadGitStatus, WorkspaceGitRecord,
} from '../domain/git-sync.js';

export interface GitSyncApplication {
  branches(projectId: string): Promise<BranchList>;
  fetch(projectId: string, input: unknown): Promise<GitOperation>;
  projectStatus(projectId: string): Promise<CheckoutStatus>;
  update(projectId: string, input: unknown): Promise<GitOperation>;
  threadStatus(taskId: string): Promise<ThreadGitStatus>;
  commit(taskId: string, input: unknown): Promise<CommitResult>;
  push(taskId: string, input: unknown): Promise<GitOperation>;
  operation(id: string): Promise<GitOperation>;
  close(): Promise<void>;
}

export type GitWorkdir = Readonly<{ cwd: string; identity: Readonly<{ dev: number; ino: number }> }>;
export type ThreadWorkspace = Readonly<{ mode: 'worktree' | 'in-place'; workdir: GitWorkdir; record: WorkspaceGitRecord | null }>;
export type RepositoryStatus = Readonly<{
  branch: string | null; headSha: string; upstream: Readonly<{ ref: string; ahead: number; behind: number }> | null;
  dirty: DirtySummary; operation: CheckoutOperation;
}>;
export type RemoteBranches = Omit<BranchList, 'fetchedAt'>;
export type PushResult = Readonly<{ created: boolean }>;

/** Resolves pinned working directories for registered projects and conversation workspaces. */
export interface GitWorkspaces {
  checkout(project: RegisteredProject, signal?: AbortSignal): Promise<GitWorkdir>;
  thread(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<ThreadWorkspace>;
}

/** Fixed no-shell Git process plans; failures surface as closed Git error codes only. */
export interface GitRepository {
  fetch(workdir: GitWorkdir, signal?: AbortSignal): Promise<void>;
  branches(workdir: GitWorkdir, signal?: AbortSignal): Promise<RemoteBranches>;
  status(workdir: GitWorkdir, excluded: readonly string[], signal?: AbortSignal): Promise<RepositoryStatus>;
  resolve(workdir: GitWorkdir, ref: string, signal?: AbortSignal): Promise<string | null>;
  divergence(workdir: GitWorkdir, left: string, right: string, signal?: AbortSignal): Promise<Readonly<{ ahead: number; behind: number }>>;
  fastForward(workdir: GitWorkdir, signal?: AbortSignal): Promise<string>;
  localAuthor(workdir: GitWorkdir, signal?: AbortSignal): Promise<GitAuthor | null>;
  commit(workdir: GitWorkdir, message: string, author: GitAuthor, excluded: readonly string[], signal?: AbortSignal): Promise<string>;
  push(workdir: GitWorkdir, sha: string, branch: string, signal?: AbortSignal): Promise<PushResult>;
}

export interface GitActivity {
  conversationActive(workspaceTaskId: string): Promise<boolean>;
  inPlaceActive(projectId: string): Promise<boolean>;
}

/** Runner-managed synchronized instruction files are never part of a user commit. */
export interface ManagedInstructionPaths {
  managedPaths(workspaceTaskId: string | null, cwd: string, isolation: 'in-place' | 'worktree'): Promise<readonly string[]>;
}

export interface OriginBaseResolver {
  resolveOriginBase(project: RegisteredProject, workdir: GitWorkdir, branch: string, signal?: AbortSignal): Promise<Readonly<{ sha: string; fetchedAt: string }>>;
}

export interface GitWorkspaceLeases {
  awaitWorkspace(key: string, signal?: AbortSignal): Promise<void>;
}
