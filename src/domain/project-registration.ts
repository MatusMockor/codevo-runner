import { RunnerError } from './contracts.js';
import type { ProjectSummary } from './execution.js';
import { validProjectDirectoryPath } from './project-clone.js';

export type ProjectRegistrationInput = Readonly<{ path: string; name: string }>;
export type ProjectRegistrationRejection = 'not_git_root' | 'name_taken' | 'limit_reached' | 'not_allowed';
export type ProjectRegistration =
  Readonly<{ status: 'registered'; project: ProjectSummary; created: boolean }> |
  Readonly<{ status: 'rejected'; reason: ProjectRegistrationRejection }>;

export function parseProjectRegistration(value: unknown): ProjectRegistrationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'path' && key !== 'name') || !validProjectDirectoryPath(v.path) ||
      typeof v.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.name)) throw new RunnerError('invalid_input');
  return { path: v.path, name: v.name };
}
