import { RunnerError } from './contracts.js';

export type WorkspaceFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export type WorkspaceFile = Readonly<{ path: string; status: WorkspaceFileStatus; oldPath?: string }>;
export type WorkspaceFiles = Readonly<{ files: readonly WorkspaceFile[]; truncated: boolean }>;
export type WorkspaceFileContent = Readonly<{ text: string; truncated: boolean }>;
export type WorkspaceFileDiff = Readonly<{
  path: string; original: WorkspaceFileContent; modified: WorkspaceFileContent;
  unavailableReason: 'binary' | 'large' | null;
}>;
export const WORKSPACE_FILE_LIMITS = Object.freeze({ pathBytes: 4096, files: 1000, listBytes: 262144, textBytes: 65536 });

export function validateWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > WORKSPACE_FILE_LIMITS.pathBytes ||
      /[\\\x00-\x1f]/.test(value) || value.startsWith('/') || /^[a-zA-Z]:/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
    throw new RunnerError('invalid_input');
  return value;
}
export function parseWorkspaceFileInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('path' in input))
    throw new RunnerError('invalid_input');
  return validateWorkspacePath(input.path);
}
