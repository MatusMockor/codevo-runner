import { RunnerError } from '../domain/contracts.js';
import { parseSurfaceInput, type SurfaceOperation } from '../domain/surface-files.js';
import type { SurfaceWorkspaceResolver } from './surface-workspace.js';
import type { SurfaceWorkspace } from './surface-workspace.js';
import type { SurfaceInput } from '../domain/surface-files.js';
export interface SurfaceOperations { perform(workspace: SurfaceWorkspace, operation: SurfaceOperation, input: SurfaceInput, signal: AbortSignal): Promise<unknown>; }

export class SurfaceService {
  private active = 0;
  constructor(private readonly resolver: SurfaceWorkspaceResolver, private readonly operations: SurfaceOperations) {}
  async capabilities(projectId: string) {
    await this.resolver.resolve(projectId);
    return { files: process.platform !== 'win32', history: process.platform !== 'win32' };
  }
  async perform(projectId: string, operation: SurfaceOperation, value: unknown) {
    const input = parseSurfaceInput(operation, value);
    if (this.active >= 4) throw new RunnerError('busy');
    this.active++;
    try {
      const signal = AbortSignal.timeout(15000);
      const workspace = await this.resolver.resolve(projectId, input.taskId, signal);
      const result = await this.operations.perform(workspace, operation, input, signal);
      await workspace.revalidate();
      return result;
    } finally { this.active--; }
  }
}
