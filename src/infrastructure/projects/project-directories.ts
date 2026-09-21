import { opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectDirectories, ProjectDirectoryListing } from '../../application/project-directories.js';
import { RunnerError } from '../../domain/contracts.js';
import { validProjectDirectoryPath } from '../../domain/project-clone.js';
import { retainCloneDirectory } from './clone-directory.js';

export class ProjectDirectoriesAdapter implements ProjectDirectories {
  private active = 0;
  constructor(private readonly root: string) {}
  async list(value: unknown, signal: AbortSignal): Promise<ProjectDirectoryListing> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== 'path') || (input.path !== undefined && !validProjectDirectoryPath(input.path))) throw new RunnerError('invalid_input');
    if (this.active >= 4) throw new RunnerError('busy');
    this.active++;
    try {
      signal.throwIfAborted();
      const directory = await retainCloneDirectory(this.root, input.path as string | undefined);
      try {
        signal.throwIfAborted();
        const entries: { name: string; path: string }[] = [];
        let visited = 0;
        let bytes = 0;
        let truncated = false;
        const stream = await opendir(directory.anchor);
        for await (const item of stream) {
          signal.throwIfAborted();
          if (++visited > 4096 || entries.length >= 256) { truncated = true; break; }
          if (!item.isDirectory() || item.isSymbolicLink() || /[\x00-\x1f\x7f-\x9f]/.test(item.name)) continue;
          const path = join(directory.path, item.name);
          bytes += Buffer.byteLength(path) + Buffer.byteLength(item.name);
          if (bytes > 128 * 1024 || !validProjectDirectoryPath(path)) { truncated = true; break; }
          entries.push({ name: item.name, path });
        }
        signal.throwIfAborted();
        if (!await directory.owned()) throw new RunnerError('storage_unavailable');
        return { path: directory.path, parentPath: directory.path === directory.root ? null : dirname(directory.path),
          entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated };
      } finally { await directory.close(); }
    } finally { this.active--; }
  }
}
