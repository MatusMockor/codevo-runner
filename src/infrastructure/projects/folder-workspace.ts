import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectWorkspace } from '../../application/execution-ports.js';
import type { GitWorkdir, GitWorkspaces } from '../../application/git-sync-ports.js';
import { isId, RunnerError, type TaskIsolation } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';
import type { StartBase } from '../../domain/git-sync.js';
import { liveIdentity } from './live-identity.js';
import { captureFolderWorkspace, loadFolderMetadata, saveMetadata, validateFolderWorkspace } from './workspace-metadata.js';

export class FolderProjectWorkspace implements ProjectWorkspace, GitWorkspaces {
  private readonly metadata: string;
  constructor(dataDir: string) { this.metadata = resolve(dataDir, 'workspace-metadata'); }

  validateStart(_project: RegisteredProject, isolation?: TaskIsolation, base?: StartBase): void {
    if (isolation !== 'in-place' || base?.kind === 'origin-branch') throw new RunnerError('invalid_input');
  }

  async repositoryIdentity(): Promise<null> { return null; }

  async prepare(project: RegisteredProject, taskId: string, signal?: AbortSignal, isolation?: TaskIsolation, base?: StartBase): Promise<string> {
    this.taskId(taskId);
    this.validateStart(project, isolation, base);
    signal?.throwIfAborted();
    const metadata = await captureFolderWorkspace(project);
    await saveMetadata(this.metadata, taskId, metadata);
    await validateFolderWorkspace(metadata, project, signal);
    return metadata.source;
  }

  async resume(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<string> {
    return (await this.pinned(project, workspaceTaskId, signal)).cwd;
  }

  async identity(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<Readonly<{ dev: number; ino: number }>> {
    return (await this.pinned(project, taskId, signal)).identity;
  }

  async checkout(project: RegisteredProject, signal?: AbortSignal): Promise<GitWorkdir> {
    signal?.throwIfAborted();
    const metadata = await captureFolderWorkspace(project);
    signal?.throwIfAborted();
    return { cwd: metadata.source, identity: metadata.sourceIdentity };
  }

  async thread(): Promise<never> { throw new RunnerError('git_not_repository'); }
  async diff(): Promise<never> { throw new RunnerError('git_not_repository'); }
  async files(): Promise<never> { throw new RunnerError('git_not_repository'); }
  async fileDiff(): Promise<never> { throw new RunnerError('git_not_repository'); }

  private async pinned(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<GitWorkdir> {
    this.taskId(taskId);
    signal?.throwIfAborted();
    const metadata = await loadFolderMetadata(this.metadata, taskId);
    if (!metadata) throw new RunnerError('conflict');
    await validateFolderWorkspace(metadata, project, signal);
    const info = await lstat(metadata.source);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('conflict');
    const identity = liveIdentity(metadata.sourceIdentity, info);
    await validateFolderWorkspace(metadata, project, signal);
    return { cwd: metadata.source, identity };
  }

  private taskId(taskId: string): void {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
  }
}
