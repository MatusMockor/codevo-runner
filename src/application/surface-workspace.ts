export type SurfaceWorkspace = Readonly<{
  cwd: string;
  identity: Readonly<{ dev: number; ino: number }>;
  revalidate(): Promise<void>;
}>;
export interface SurfaceWorkspaceResolver {
  resolve(projectId: string, taskId?: string, signal?: AbortSignal): Promise<SurfaceWorkspace>;
}
