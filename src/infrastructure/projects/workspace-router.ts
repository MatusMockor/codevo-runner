import { resolve } from 'node:path';
import type { ProjectWorkspace } from '../../application/execution-ports.js';
import type { GitWorkdir, GitWorkspaces, ThreadWorkspace } from '../../application/git-sync-ports.js';
import { isId, RunnerError, type TaskIsolation } from '../../domain/contracts.js';
import type { ProjectKind, RegisteredProject, WorkspaceDiff } from '../../domain/execution.js';
import type { StartBase } from '../../domain/git-sync.js';
import { projectKind } from '../../domain/project-kind.js';
import type { WorkspaceFileDiff, WorkspaceFiles } from '../../domain/workspace-files.js';
import { loadStoredMetadata, type StoredWorkspaceMetadata } from './workspace-metadata.js';

type KindWorkspace = ProjectWorkspace & GitWorkspaces & Required<Pick<ProjectWorkspace, 'identity' | 'repositoryIdentity'>>;
type RepositoryWorkspace = KindWorkspace & Required<Pick<ProjectWorkspace, 'awaitGitLease'>>;
type FolderWorkspace = KindWorkspace & Required<Pick<ProjectWorkspace, 'validateStart'>>;

export class ProjectWorkspaceRouter implements ProjectWorkspace, GitWorkspaces {
  private readonly metadata: string;
  constructor(dataDir: string, private readonly repositories: RepositoryWorkspace, private readonly folders: FolderWorkspace) {
    this.metadata = resolve(dataDir, 'workspace-metadata');
  }

  validateStart(project: RegisteredProject, isolation?: TaskIsolation, base?: StartBase): void {
    const kind = projectKind(project);
    switch (kind) {
      case 'repository': return;
      case 'folder': return this.folders.validateStart(project, isolation, base);
      default: return unreachable(kind);
    }
  }

  repositoryIdentity(project: RegisteredProject, signal?: AbortSignal): Promise<string | null> {
    return this.of(projectKind(project)).repositoryIdentity(project, signal);
  }

  async awaitGitLease(project: RegisteredProject, workspaceTaskId: string, isolation: TaskIsolation, signal?: AbortSignal): Promise<void> {
    const kind = projectKind(project);
    switch (kind) {
      case 'repository': return this.repositories.awaitGitLease(project, workspaceTaskId, isolation, signal);
      case 'folder': return;
      default: return unreachable(kind);
    }
  }

  prepare(project: RegisteredProject, taskId: string, signal?: AbortSignal, isolation?: TaskIsolation, base?: StartBase): Promise<string> {
    return this.of(projectKind(project)).prepare(project, taskId, signal, isolation, base);
  }

  checkout(project: RegisteredProject, signal?: AbortSignal): Promise<GitWorkdir> {
    return this.of(projectKind(project)).checkout(project, signal);
  }

  async resume(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<string> {
    return (await this.ofTask(workspaceTaskId, project)).resume(project, workspaceTaskId, signal);
  }

  async identity(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<Readonly<{ dev: number; ino: number }>> {
    return (await this.ofTask(taskId, project)).identity(project, taskId, signal);
  }

  async thread(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<ThreadWorkspace> {
    return (await this.ofTask(workspaceTaskId, project)).thread(project, workspaceTaskId, signal);
  }

  async diff(taskId: string, project?: RegisteredProject): Promise<WorkspaceDiff> {
    return (await this.ofTask(taskId, project)).diff(taskId, project);
  }

  async files(project: RegisteredProject, taskId: string): Promise<WorkspaceFiles> {
    return (await this.ofTask(taskId, project)).files(project, taskId);
  }

  async fileDiff(project: RegisteredProject, taskId: string, path: string): Promise<WorkspaceFileDiff> {
    return (await this.ofTask(taskId, project)).fileDiff(project, taskId, path);
  }

  private of(kind: ProjectKind): KindWorkspace {
    switch (kind) {
      case 'repository': return this.repositories;
      case 'folder': return this.folders;
      default: return unreachable(kind);
    }
  }

  private async ofTask(taskId: string, project?: RegisteredProject): Promise<KindWorkspace> {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    const stored = await loadStoredMetadata(this.metadata, taskId);
    const recorded = stored ? metadataKind(stored) : undefined;
    const kind = project ? projectKind(project) : recorded ?? 'repository';
    if (recorded !== undefined && recorded !== kind) throw new RunnerError('conflict');
    return this.of(kind);
  }
}

function metadataKind(metadata: StoredWorkspaceMetadata): ProjectKind {
  switch (metadata.version) {
    case 1: return 'repository';
    case 2: return metadata.kind;
    default: return unreachable(metadata);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled project kind: ${String(value)}`);
}
