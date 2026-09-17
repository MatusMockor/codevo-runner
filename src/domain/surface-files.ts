import { isId, RunnerError } from './contracts.js';
import { validateWorkspacePath } from './workspace-files.js';
export type SurfaceEntry = Readonly<{ name: string; path: string; kind: 'file' | 'directory' | 'symlink' }>;
export type SurfaceTree = Readonly<{ entries: readonly SurfaceEntry[]; nextOffset: number | null; truncated: boolean }>;
export type SurfaceFile = Readonly<{ path: string; text: string; version: string | null; unavailableReason: 'binary' | 'large' | null }>;
export type SurfaceOperation = 'tree' | 'read' | 'write' | 'history' | 'commit-files' | 'commit-diff';
export type SurfaceInput = Readonly<{ taskId?: string; path?: string; offset?: number; text?: string; expectedVersion?: string; commit?: string }>;
export function parseSurfaceInput(operation: SurfaceOperation, value: unknown): SurfaceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const input = value as Record<string, unknown>;
  const required = { tree: ['path', 'offset'], read: ['path'], write: ['path', 'text', 'expectedVersion'], history: ['offset'], 'commit-files': ['commit'], 'commit-diff': ['commit', 'path'] }[operation];
  if (required.some(key => !(key in input)) || Object.keys(input).some(key => key !== 'taskId' && !required.includes(key))) throw new RunnerError('invalid_input');
  if ('taskId' in input && !isId(input.taskId)) throw new RunnerError('invalid_input');
  if ('path' in input && !(operation === 'tree' && input.path === '')) validateWorkspacePath(input.path);
  if ('offset' in input && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 100000)) throw new RunnerError('invalid_input');
  if ('commit' in input && (typeof input.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commit))) throw new RunnerError('invalid_input');
  if ('text' in input && (typeof input.text !== 'string' || new TextEncoder().encode(input.text).length > 65536 || input.text.includes('\0'))) throw new RunnerError('too_large');
  if ('expectedVersion' in input && (typeof input.expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedVersion))) throw new RunnerError('invalid_input');
  return input as SurfaceInput;
}
