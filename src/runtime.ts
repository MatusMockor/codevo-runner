import { SpeechTranscriptionService } from './application/speech-transcription-service.js';
import { HttpSpeechTranscriber } from './infrastructure/speech/http-transcriber.js';
import { AccountUsageService } from './application/account-usage-service.js';
import { CliAccountUsageReader } from './infrastructure/execution/account-usage.js';
import type { UsageProcessOptions } from './infrastructure/execution/account-usage-process.js';
import { CommandCatalogService } from './application/command-catalog-service.js';
import { CliCommandCatalogReader, type CommandCatalogCliOptions } from './infrastructure/execution/command-catalog.js';
import { McpServersService } from './application/mcp-servers-service.js';
import { CliMcpServersReader, type McpServersCliOptions } from './infrastructure/execution/mcp-servers.js';
import { FileTurnChangesStore } from './infrastructure/projects/turn-changes.js';
import { RepositoryLookupService } from './application/repository-lookup-service.js';
import { CliRepositoryLookup } from './infrastructure/projects/repository-lookup.js';
import { ThreadMetadataService } from './application/thread-metadata.js';
import { ProjectDirectoriesAdapter } from './infrastructure/projects/project-directories.js';
import { FileSystemSurfaceOperations } from './infrastructure/projects/surface-operations.js';
import { TerminalService } from './application/terminal-service.js';
import { NodePtyFactory } from './infrastructure/terminal/node-pty.js';
import { SurfaceService } from './application/surface-service.js';
import { RegisteredSurfaceWorkspaceResolver } from './infrastructure/projects/surface-workspace.js';
import { executionTimeoutMs } from './domain/execution-policy.js';
import { QuestionService } from './application/question-service.js';
import { ApprovalService } from './application/approval-service.js';
import { FileInstructionWorkspace } from './infrastructure/files/instruction-workspace.js';
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
import { GitCoordination, type GitCoordinationOptions } from './application/git-coordination.js';
import { GitOriginBases, GitSyncService, type GitSyncOptions } from './application/git-sync-service.js';
import { GitRepositoryAdapter, type GitRepositoryTimeouts } from './infrastructure/projects/git-sync.js';
import type { GitAuthor } from './domain/git-sync.js';
import { ProcessOwnershipRegistry } from './application/process-ownership.js';
import { PortPreviewService } from './application/port-preview-service.js';
import { ProcListeningPortScanner } from './infrastructure/execution/listening-ports.js';

export type RunnerExecutionOptions = Readonly<{
  projects: readonly RegisteredProject[];
  accountUsageCli?: UsageProcessOptions;
  commandCatalogCli?: CommandCatalogCliOptions;
  mcpServersCli?: McpServersCliOptions;
  projectsRoot?: string;
  executionTimeoutMs?: number;
  executionConcurrency?: number;
  providers?: readonly ProviderExecutor[];
  isolation?: 'provider' | 'container';
  gitAuthor?: GitAuthor;
  listenPort?: number;
  gitSync?: Readonly<{ coordination?: GitCoordinationOptions; timeouts?: GitRepositoryTimeouts; service?: Omit<GitSyncOptions, 'author'> }>;
}>;

export type RunnerSpeechOptions = Readonly<{ url: string; timeoutMs?: number }>;

/** Composition root: concrete infrastructure is wired only at the outside edge. */
export async function openRunnerServices(dataDir: string, runnerId: string, options?: RunnerExecutionOptions, speechOptions?: RunnerSpeechOptions) {
  const speech = speechOptions
    ? new SpeechTranscriptionService(new HttpSpeechTranscriber(speechOptions.url), { timeoutMs: speechOptions.timeoutMs }) : undefined;
  const timeoutMs = executionTimeoutMs(options?.executionTimeoutMs);
  const changes = new RunnerChanges();
  const repository = await openSqliteRepository(dataDir, runnerId, () => changes.publish());
  try {
    const accountUsage = new AccountUsageService(new CliAccountUsageReader(options?.accountUsageCli));
    const questions = new QuestionService(repository);
    await questions.expire();
    const approvals = new ApprovalService(repository);
    // Recovery is truthful even when an operator disables execution after a crash.
    await repository.interruptRunningTasks();
    await repository.interruptClones();
    const attachments = await createAttachmentStore(dataDir, runnerId, repository);
    let execution: ExecutionService | undefined;
    let surfaces: SurfaceService | undefined;
    let terminals: TerminalService | undefined;
    let artifacts: ArtifactService | undefined;
    let clones: ProjectCloneService | undefined;
    let gitSync: GitSyncService | undefined;
    let ports: PortPreviewService | undefined;
    let commandCatalog: CommandCatalogService | undefined;
    let mcpServers: McpServersService | undefined;
    try {
      if (options) {
        const configured = new ConfiguredProjectRegistry(options.projects);
        clones = new ProjectCloneService(repository, new GitCloneAdapter(options.projectsRoot ?? join(homedir(), 'Developer')), configured);
        await clones.initialize();
        const surfaceResolver = new RegisteredSurfaceWorkspaceResolver(
          new ManagedProjectRegistry(configured, repository), new GitProjectWorkspace(dataDir), repository, repository);
        surfaces = new SurfaceService(surfaceResolver, new FileSystemSurfaceOperations());
        terminals = new TerminalService(surfaceResolver, new NodePtyFactory());
        const cliOptions = { timeoutMs, interactiveQuestions: true, sandbox: options.isolation === 'container' ? 'external-sandbox' as const : 'workspace-write' as const };
        artifacts = new ArtifactService(repository, repository,
          new WorkspaceArtifactReader(repository, repository, new ManagedProjectRegistry(configured, repository), new GitProjectWorkspace(dataDir), join(dataDir, 'workspaces')),
          await FileArtifactBlobs.open(dataDir, await repository.listArtifactIds()));
        const instructionWorkspace = new FileInstructionWorkspace(dataDir);
        const coordination = new GitCoordination(options.gitSync?.coordination);
        const gitRepository = new GitRepositoryAdapter(options.gitSync?.timeouts);
        const executionWorkspace = new GitProjectWorkspace(dataDir, { bases: new GitOriginBases(coordination, gitRepository), leases: coordination });
        gitSync = new GitSyncService(repository, repository, new ManagedProjectRegistry(configured, repository), executionWorkspace,
          gitRepository, coordination, { ...options.gitSync?.service, ...(options.gitAuthor ? { author: options.gitAuthor } : {}) }, instructionWorkspace);
        const processOwnership = new ProcessOwnershipRegistry();
        execution = new ExecutionService(repository, repository,
          new ManagedProjectRegistry(configured, repository), executionWorkspace,
          options.providers ?? [new CliProviderExecutor('codex', cliOptions), new CliProviderExecutor('claude', cliOptions)],
          await createExecutionAttachmentStager(dataDir, attachments),
          (taskId, paths) => artifacts!.captureOutput(taskId, paths), instructionWorkspace, questions, new FileTurnChangesStore(dataDir), options.executionConcurrency, processOwnership, approvals);
        await execution.initialize();
        // Catalogs describe the provider CLIs tasks launch; injected executors need an explicit probe configuration.
        if (options.providers === undefined || options.commandCatalogCli) {
          commandCatalog = new CommandCatalogService(new ManagedProjectRegistry(configured, repository), executionWorkspace,
            new CliCommandCatalogReader(options.commandCatalogCli));
        }
        if (options.providers === undefined || options.mcpServersCli) {
          mcpServers = new McpServersService(new ManagedProjectRegistry(configured, repository), executionWorkspace,
            new CliMcpServersReader(options.mcpServersCli));
        }
        if (process.platform === 'linux') {
          ports = new PortPreviewService(repository, new ManagedProjectRegistry(configured, repository), processOwnership, terminals,
            new ProcListeningPortScanner(), { excludedPorts: options.listenPort === undefined ? [] : [options.listenPort] });
        }

      }
    } catch (error) {
      try {
        try { await execution?.close(); }
        finally {
          try { await terminals?.close(); }
          finally {
            try { await clones?.close(); }
            finally { await gitSync?.close(); }
          }
        }
      } finally { await attachments.close(); }
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      speech, accountUsage, commandCatalog, mcpServers, surfaces, terminals,
      repositories: options ? new RepositoryLookupService(new CliRepositoryLookup()) : undefined,
      projectDirectories: options ? new ProjectDirectoriesAdapter(options.projectsRoot ?? join(homedir(), 'Developer')) : undefined,
      threadMetadata: new ThreadMetadataService(repository),
      questions: execution ? questions : undefined,
      approvals: execution ? approvals : undefined,
      historySearch: new HistorySearchService(repository), tasks: new TaskService(repository), attachments, execution, clones, changes, artifacts, gitSync, ports,
      close(): Promise<void> {
        closing ??= (async () => {
          // Fence execution synchronously before the first await; usage and catalog
          // probes own separate cancellations and must not reopen the admission window.
          const executionClosing = execution?.close();
          const usageClosing = accountUsage.close();
          const catalogClosing = commandCatalog?.close();
          const mcpServersClosing = mcpServers?.close();
          const speechClosing = speech?.close();
          try {
            try { await executionClosing; }
            finally {
              try { await speechClosing; await usageClosing; }
              finally {
                try { await catalogClosing; await mcpServersClosing; }
                finally {
                  try { await terminals?.close(); }
                  finally {
                    try { await clones?.close(); }
                    finally { await gitSync?.close(); }
                  }
                }
              }
            }
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
