import { RunnerError } from '../domain/contracts.js';
import type { ProjectKind } from '../domain/execution.js';
import { NOT_A_REPOSITORY_REASON, projectKind } from '../domain/project-kind.js';
import type { TurnChangesSummary, TurnFileDiff } from '../domain/turn-changes.js';
import type { ProjectRegistry } from './execution-ports.js';
import type { TaskRepository } from './ports.js';
import type { TurnChanges } from './turn-changes.js';

type Identity = Readonly<{ dev: number; ino: number }>;

export class FolderTurnChanges implements TurnChanges {
  async captureStart(): Promise<void> {}
  async captureEnd(): Promise<void> {}
  async summary(taskId: string): Promise<TurnChangesSummary> {
    return { turnId: taskId, state: 'unavailable', files: [], truncated: false, reason: NOT_A_REPOSITORY_REASON };
  }
  async diff(): Promise<TurnFileDiff> { throw new RunnerError('not_found'); }
}

export class ProjectTurnChanges implements TurnChanges {
  constructor(private readonly tasks: Pick<TaskRepository, 'getTask'>, private readonly registry: Pick<ProjectRegistry, 'get'>,
    private readonly repositories: TurnChanges, private readonly folders: TurnChanges) {}

  async captureStart(taskId: string, cwd: string, identity: Identity, signal: AbortSignal): Promise<void> {
    return this.of(await this.kind(taskId)).captureStart(taskId, cwd, identity, signal);
  }

  async captureEnd(taskId: string, cwd: string, identity: Identity, signal: AbortSignal): Promise<void> {
    return this.of(await this.kind(taskId)).captureEnd(taskId, cwd, identity, signal);
  }

  async summary(taskId: string): Promise<TurnChangesSummary> {
    return this.of(await this.kind(taskId).catch(retained)).summary(taskId);
  }

  async diff(taskId: string, relativePath: string): Promise<TurnFileDiff> {
    return this.of(await this.kind(taskId).catch(retained)).diff(taskId, relativePath);
  }

  private async kind(taskId: string): Promise<ProjectKind> {
    const { projectId } = await this.tasks.getTask(taskId);
    if (!projectId) return 'repository';
    return projectKind(await this.registry.get(projectId));
  }

  private of(kind: ProjectKind): TurnChanges {
    switch (kind) {
      case 'repository': return this.repositories;
      case 'folder': return this.folders;
      default: return unreachable(kind);
    }
  }
}

function retained(error: unknown): ProjectKind {
  if (error instanceof RunnerError && error.code === 'not_found') return 'repository';
  throw error;
}

function unreachable(value: never): never {
  throw new Error(`Unhandled project kind: ${String(value)}`);
}
