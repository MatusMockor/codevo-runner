import { lstat, realpath } from 'node:fs/promises';
import type { ProjectRegistry, ProjectWorkspace, ExecutionRepository } from '../../application/execution-ports.js';
import type { TaskRepository } from '../../application/ports.js';
import type { SurfaceWorkspaceResolver, SurfaceWorkspace } from '../../application/surface-workspace.js';
import { isId, RunnerError } from '../../domain/contracts.js';

export class RegisteredSurfaceWorkspaceResolver implements SurfaceWorkspaceResolver {
  constructor(private readonly registry: ProjectRegistry, private readonly workspaces: ProjectWorkspace,
    private readonly tasks: Pick<TaskRepository, 'getTask'>, private readonly executions: Pick<ExecutionRepository, 'getTaskSession'>) {}
  async resolve(projectId: string, taskId?: string, signal?: AbortSignal): Promise<SurfaceWorkspace> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId) || (taskId !== undefined && !isId(taskId))) throw new RunnerError('invalid_input');
    const project = await this.registry.get(projectId);
    const workspaceTaskId = taskId === undefined ? undefined : await this.workspaceTask(projectId, taskId);
    const cwd = workspaceTaskId === undefined ? await realpath(project.path) : await this.workspaces.resume(project, workspaceTaskId, signal);
    const identity = await lstat(cwd);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new RunnerError('conflict');
    const revalidate = async () => {
      signal?.throwIfAborted();
      const currentProject = await this.registry.get(projectId);
      if (currentProject.path !== project.path) throw new RunnerError('conflict');
      if (taskId !== undefined && await this.workspaceTask(projectId, taskId) !== workspaceTaskId) throw new RunnerError('conflict');
      const current = workspaceTaskId === undefined ? await realpath(currentProject.path) : await this.workspaces.resume(currentProject, workspaceTaskId, signal);
      const info = await lstat(current);
      if (current !== cwd || !info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) throw new RunnerError('conflict');
      signal?.throwIfAborted();
    };
    await revalidate();
    return { cwd, identity: { dev: identity.dev, ino: identity.ino }, revalidate };
  }
  private async workspaceTask(projectId: string, taskId: string) {
    if ((await this.tasks.getTask(taskId)).projectId !== projectId) throw new RunnerError('not_found');
    const session = await this.executions.getTaskSession(taskId);
    if ((await this.tasks.getTask(session.workspaceTaskId)).projectId !== projectId) throw new RunnerError('not_found');
    return session.workspaceTaskId;
  }
}
