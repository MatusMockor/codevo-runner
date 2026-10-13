import type { ProjectKind } from '../domain/execution.js';

export type SurfaceWorkspace = Readonly<{
  cwd: string;
  identity: Readonly<{ dev: number; ino: number }>;
  kind?: ProjectKind;
  revalidate(): Promise<void>;
}>;
export interface SurfaceWorkspaceResolver {
  resolve(projectId: string, taskId?: string, signal?: AbortSignal): Promise<SurfaceWorkspace>;
}
