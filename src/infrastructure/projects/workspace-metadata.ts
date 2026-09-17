import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { RunnerError } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';
import { git } from './git-command.js';

type Identity = Readonly<{ dev: number; ino: number }>;
export type WorkspaceMetadata = Readonly<{
  version: 1; mode: 'in-place' | 'worktree'; projectId: string;
  source: string; sourceIdentity: Identity; common: string; commonIdentity: Identity;
}>;
const LIMIT = 16 * 1024;

export async function captureWorkspace(project: RegisteredProject, mode: WorkspaceMetadata['mode'], signal?: AbortSignal): Promise<WorkspaceMetadata> {
  const source = await realpath(project.path);
  const sourceIdentity = await directoryIdentity(source);
  const top = (await git(source, ['rev-parse', '--show-toplevel'], signal, sourceIdentity)).text.trim();
  if (await realpath(top) !== source) throw new RunnerError('conflict');
  const common = await realpath((await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, sourceIdentity)).text.trim());
  const commonIdentity = await directoryIdentity(common);
  const result = { version: 1 as const, mode, projectId: project.id, source, sourceIdentity, common, commonIdentity };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) throw new RunnerError('conflict');
  return result;
}

export async function validateWorkspace(metadata: WorkspaceMetadata, project: RegisteredProject, signal?: AbortSignal) {
  const current = await captureWorkspace(project, metadata.mode, signal);
  if (JSON.stringify(current) !== JSON.stringify(metadata)) throw new RunnerError('conflict');
  signal?.throwIfAborted();
}

export async function saveMetadata(root: string, taskId: string, metadata: WorkspaceMetadata) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await directoryIdentity(root);
  await writeFile(join(root, taskId), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
}

export async function loadMetadata(root: string, taskId: string): Promise<WorkspaceMetadata | undefined> {
  try { await directoryIdentity(root); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  let file;
  try { file = await open(join(root, taskId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > LIMIT) throw new RunnerError('conflict');
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LIMIT) throw new RunnerError('conflict');
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!value || typeof value !== 'object') throw new RunnerError('conflict');
    const m = value as Record<string, unknown>;
    if (Object.keys(m).sort().join(',') !== 'common,commonIdentity,mode,projectId,source,sourceIdentity,version' ||
        m.version !== 1 || (m.mode !== 'in-place' && m.mode !== 'worktree') || typeof m.projectId !== 'string' ||
        typeof m.source !== 'string' || !isAbsolute(m.source) || typeof m.common !== 'string' || !isAbsolute(m.common) ||
        !validIdentity(m.sourceIdentity) || !validIdentity(m.commonIdentity)) throw new RunnerError('conflict');
    return { version: 1, mode: m.mode, projectId: m.projectId, source: m.source,
      sourceIdentity: m.sourceIdentity, common: m.common, commonIdentity: m.commonIdentity };
  } finally { await file.close(); }
}

async function directoryIdentity(path: string): Promise<Identity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('conflict');
  return { dev: info.dev, ino: info.ino };
}
function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'dev,ino' && typeof v.dev === 'number' && typeof v.ino === 'number' &&
    Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino) && v.dev >= 0 && v.ino >= 0;
}
function missing(error: unknown) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
