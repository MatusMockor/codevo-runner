import type { ProjectSummary, RegisteredProject } from '../domain/execution.js';
import type { ProjectRegistration } from '../domain/project-registration.js';
export type ProjectFolderVerdict = 'git_root' | 'not_git_root' | 'not_allowed';
export type RetainedProjectFolder = Readonly<{
  root: string;
  path: string;
  verdict: ProjectFolderVerdict;
  matches(path: string): Promise<boolean>;
  owned(): Promise<boolean>;
  close(): Promise<void>;
}>;
export interface ProjectFolderInspector {
  retain(path: string, signal: AbortSignal): Promise<RetainedProjectFolder>;
}
export interface ProjectRegistrationRepository {
  registerManagedProject(project: RegisteredProject, configured: readonly ProjectSummary[], projectsRoot: string): Promise<ProjectRegistration>;
}
export interface ProjectRegistrationApplication {
  register(value: unknown, signal: AbortSignal): Promise<ProjectRegistration>;
  close(): Promise<void>;
}
