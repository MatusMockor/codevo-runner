import { lstat } from 'node:fs/promises';
import { RunnerError } from '../../domain/contracts.js';

export async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunnerError('storage_unavailable');
}
