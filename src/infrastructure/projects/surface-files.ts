import { validateWorkspacePath } from '../../domain/workspace-files.js';
import { RunnerError } from '../../domain/contracts.js';
import { parseSurfaceInput, type SurfaceInput, type SurfaceTree, type SurfaceFile } from '../../domain/surface-files.js';
import type { SurfaceWorkspace } from '../../application/surface-workspace.js';
import { runProcess } from '../execution/process-runner.js';
import { SURFACE_FILES_HELPER } from './surface-file-helper.js';

const writes = new Set<string>();
export async function surfaceFiles(workspace: SurfaceWorkspace, operation: 'tree' | 'read' | 'write', input: SurfaceInput, signal: AbortSignal): Promise<SurfaceTree | SurfaceFile> {
  parseSurfaceInput(operation, input);
  const key = `${workspace.identity.dev}:${workspace.identity.ino}:${input.path}`;
  if (operation === 'write' && writes.has(key)) throw new RunnerError('conflict');
  if (operation === 'write') writes.add(key);
  try {
  await workspace.revalidate();
  let output = '';
  const result = await runProcess({ executable: 'python3', args: ['-I', '-S', '-c', SURFACE_FILES_HELPER], cwd: '/',
    stdin: JSON.stringify({ ...input, operation, cwd: workspace.cwd, identity: workspace.identity }),
    env: { PATH: process.env.PATH }, signal, timeoutMs: 10000, outputBytes: 1024 * 1024,
    onOutput: async (channel, text) => { if (channel === 'stdout') output += text; } });
  if (result.error || result.exitCode !== 0) throw new RunnerError('storage_unavailable');
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new RunnerError('storage_unavailable'); }
  if (!value || typeof value !== 'object') throw new RunnerError('storage_unavailable');
  if ('error' in value) throw new RunnerError(value.error === 'not_found' ? 'not_found' : 'conflict');
  await workspace.revalidate();
  return validateResponse(value, operation);
  } finally { if (operation === 'write') writes.delete(key); }
}

function validateResponse(value: object, operation: 'tree' | 'read' | 'write'): SurfaceTree | SurfaceFile {
  const response = value as Record<string, unknown>;
  const invalid = () => { throw new RunnerError('storage_unavailable'); };
  if (operation === 'tree') {
    if (Object.keys(response).length !== 3 || !Array.isArray(response.entries) || response.entries.length > 200 ||
      typeof response.truncated !== 'boolean' || (response.nextOffset !== null && (!Number.isSafeInteger(response.nextOffset) || Number(response.nextOffset) < 0))) return invalid();
    for (const entry of response.entries) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 3 || typeof entry.name !== 'string' ||
        typeof entry.path !== 'string' || !['file', 'directory', 'symlink'].includes(entry.kind) || entry.path.split('/').at(-1) !== entry.name) return invalid();
      try { validateWorkspacePath(entry.path); } catch { return invalid(); }
    }
    return response as SurfaceTree;
  }
  if (Object.keys(response).length !== 4 || typeof response.path !== 'string' || typeof response.text !== 'string' ||
    Buffer.byteLength(response.text) > 65536 || ![null, 'binary', 'large'].includes(response.unavailableReason as string | null)) return invalid();
  if (response.unavailableReason === null) {
    if (typeof response.version !== 'string' || !/^[0-9a-f]{64}$/.test(response.version)) return invalid();
  } else if (response.version !== null || response.text !== '') return invalid();
  return response as SurfaceFile;
}
