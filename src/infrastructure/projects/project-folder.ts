import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ProjectFolderInspector, ProjectFolderVerdict, RetainedProjectFolder } from '../../application/project-registration-ports.js';
import { RunnerError } from '../../domain/contracts.js';
import { retainCloneDirectory } from './clone-directory.js';
import { git } from './git-command.js';

type RetainedDirectory = Awaited<ReturnType<typeof retainCloneDirectory>>;

/** Runner-owned storage lives beneath the projects root and must never become a project. */
export class GitProjectFolderInspector implements ProjectFolderInspector {
  constructor(private readonly root: string, private readonly dataDir: string) {}
  async retain(path: string, signal: AbortSignal): Promise<RetainedProjectFolder> {
    const directory = await retainCloneDirectory(this.root, path).catch(unselectable);
    try {
      const verdict = await this.verdict(directory, signal);
      return { root: directory.root, path: directory.path, verdict, owned: directory.owned, close: directory.close,
        matches: async other => await realpath(other).catch(() => undefined) === directory.path };
    } catch (error) { await directory.close(); throw error; }
  }
  private async verdict(directory: RetainedDirectory, signal: AbortSignal): Promise<ProjectFolderVerdict> {
    const storage = await realpath(this.dataDir).catch(() => { throw new RunnerError('storage_unavailable'); });
    if (directory.path === directory.root || within(storage, directory.path)) return 'not_allowed';
    const top = await git(directory.path, ['rev-parse', '--show-toplevel'], signal, directory.identity)
      .then(result => result.text.replace(/\n$/, ''), () => undefined);
    signal.throwIfAborted();
    if (top === undefined || await realpath(top).catch(() => undefined) !== directory.path) return 'not_git_root';
    return 'git_root';
  }
}

function within(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

const UNSELECTABLE: readonly unknown[] = ['ENOTDIR', 'ENOENT', 'ELOOP', 'EACCES', 'EPERM'];

function unselectable(error: unknown): never {
  if (error instanceof Error && 'code' in error && UNSELECTABLE.includes(error.code)) throw new RunnerError('invalid_input');
  throw error;
}
