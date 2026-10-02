import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnerError } from '../../domain/contracts.js';
import { validGitBranchName, validGitSha, type WorkspaceGitRecord } from '../../domain/git-sync.js';
import { isWireTimestamp } from '../../domain/git-sync-wire.js';

const LIMIT = 4096;

export function validWorkspaceGitRecord(value: unknown): value is WorkspaceGitRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'baseBranch,baseSha,fetchedAt,threadBranch,version' &&
    record.version === 1 && validGitBranchName(record.baseBranch) && validGitSha(record.baseSha) &&
    validGitBranchName(record.threadBranch) && record.threadBranch.startsWith('codevo/') &&
    (record.fetchedAt === null || isWireTimestamp(record.fetchedAt));
}

async function privateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('conflict');
}

export async function saveWorkspaceGit(root: string, taskId: string, record: WorkspaceGitRecord): Promise<void> {
  if (!validWorkspaceGitRecord(record)) throw new RunnerError('invalid_input');
  await privateRoot(root);
  await writeFile(join(root, taskId), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
}

export async function loadWorkspaceGit(root: string, taskId: string): Promise<WorkspaceGitRecord | null> {
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new RunnerError('conflict');
  });
  if (!rootInfo) return null;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new RunnerError('conflict');
  let file;
  try { file = await open(join(root, taskId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new RunnerError('conflict');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > LIMIT) throw new RunnerError('conflict');
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LIMIT) throw new RunnerError('conflict');
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new RunnerError('conflict'); }
    if (!validWorkspaceGitRecord(value)) throw new RunnerError('conflict');
    return value;
  } finally { await file.close(); }
}
