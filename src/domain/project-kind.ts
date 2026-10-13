import { RunnerError } from './contracts.js';
import type { ProjectKind, RegisteredProject } from './execution.js';

export const FOLDER_PROJECTS_CAPABILITY = 'folderProjects';
export const NOT_A_REPOSITORY_REASON = 'This project is not a Git repository.';

export function projectKind(project: Pick<RegisteredProject, 'kind'>): ProjectKind {
  return project.kind === 'folder' ? 'folder' : 'repository';
}

export function requireRepository(project: Pick<RegisteredProject, 'kind'>): void {
  if (projectKind(project) === 'folder') throw new RunnerError('git_not_repository');
}
