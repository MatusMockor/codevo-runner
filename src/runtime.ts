import { ArtifactService } from './application/artifact-service.js';
import { FileArtifactBlobs } from './infrastructure/artifacts/blobs.js';
import { WorkspaceArtifactReader } from './infrastructure/artifacts/workspace.js';
import { HistorySearchService } from './application/history-search.js';
import { RunnerChanges } from './application/runner-changes.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectCloneService, ManagedProjectRegistry } from './application/project-clone-service.js';
import { GitCloneAdapter } from './infrastructure/projects/clone.js';
import { TaskService } from './application/task-service.js';
import { openSqliteRepository } from './infrastructure/sqlite/index.js';
import { createAttachmentStore } from './infrastructure/files/index.js';
import { ExecutionService } from './application/execution-service.js';
import type { ProviderExecutor } from './application/execution-ports.js';
import type { RegisteredProject } from './domain/execution.js';
import { ConfiguredProjectRegistry, GitProjectWorkspace } from './infrastructure/projects/index.js';
import { CliProviderExecutor } from './infrastructure/execution/index.js';
import { createExecutionAttachmentStager } from './infrastructure/files/execution-attachments.js';

export type RunnerExecutionOptions = Readonly<{
  projects: readonly RegisteredProject[];
  projectsRoot?: string;
  providers?: readonly ProviderExecutor[];
  isolation?: 'provider' | 'container';
}>;

/** Composition root: concrete infrastructure is wired only at the outside edge. */
export async function openRunnerServices(dataDir: string, runnerId: string, options?: RunnerExecutionOptions) {
  const changes = new RunnerChanges();
  const repository = await openSqliteRepository(dataDir, runnerId, () => changes.publish());
  try {
    // Recovery is truthful even when an operator disables execution after a crash.
    await repository.interruptRunningTasks();
    await repository.interruptClones();
    const attachments = await createAttachmentStore(dataDir, runnerId, repository);
    let execution: ExecutionService | undefined;
    let artifacts: ArtifactService | undefined;
    let clones: ProjectCloneService | undefined;
    try {
      if (options) {
        const configured = new ConfiguredProjectRegistry(options.projects);
        clones = new ProjectCloneService(repository, new GitCloneAdapter(options.projectsRoot ?? join(homedir(), 'Developer')), configured);
        await clones.initialize();
        const cliOptions = { sandbox: options.isolation === 'container' ? 'external-sandbox' as const : 'workspace-write' as const };
        artifacts = new ArtifactService(repository, repository,
          new WorkspaceArtifactReader(repository, repository, new ManagedProjectRegistry(configured, repository), new GitProjectWorkspace(dataDir), join(dataDir, 'workspaces')),
          await FileArtifactBlobs.open(dataDir, await repository.listArtifactIds()));
        execution = new ExecutionService(repository, repository,
          new ManagedProjectRegistry(configured, repository), new GitProjectWorkspace(dataDir),
          options.providers ?? [new CliProviderExecutor('codex', cliOptions), new CliProviderExecutor('claude', cliOptions)],
          await createExecutionAttachmentStager(dataDir, attachments),
          (taskId, paths) => artifacts!.captureOutput(taskId, paths));
        await execution.initialize();

      }
    } catch (error) {
      try {
        try { await clones?.close(); }
        finally { await execution?.close(); }
      } finally { await attachments.close(); }
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      historySearch: new HistorySearchService(repository), tasks: new TaskService(repository), attachments, execution, clones, changes, artifacts,
      close(): Promise<void> {
        closing ??= (async () => {
          try {
            try { await clones?.close(); }
            finally { await execution?.close(); }
          } finally {
            try { await attachments.close(); }
            finally { await repository.close(); }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await repository.close();
    throw error;
  }
}
