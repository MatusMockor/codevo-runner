import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RunnerError } from '../../domain/contracts.js';
import { validProjectDirectoryPath } from '../../domain/project-clone.js';

/** Retains the selected directory identity across asynchronous clone work. */
export async function retainCloneDirectory(configuredRoot: string, selected?: string) {
  if (!isAbsolute(configuredRoot) || (selected !== undefined && !validProjectDirectoryPath(selected))) throw new RunnerError('invalid_input');
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const configuredIdentity = await lstat(configuredRoot);
  if (!configuredIdentity.isDirectory() || configuredIdentity.isSymbolicLink()) throw new RunnerError('storage_unavailable');
  const root = await realpath(configuredRoot);
  const requested = selected === undefined ? root : resolve(selected);
  const path = await realpath(requested).catch(() => { throw new RunnerError('invalid_input'); });
  const suffix = relative(root, path);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || path !== requested) throw new RunnerError('invalid_input');
  const rootIdentity = await lstat(root);
  if (rootIdentity.dev !== configuredIdentity.dev || rootIdentity.ino !== configuredIdentity.ino) throw new RunnerError('storage_unavailable');
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    const owned = async () => {
      const nowConfigured = await lstat(configuredRoot).catch(() => undefined);
      const nowRoot = await lstat(root).catch(() => undefined);
      const now = await lstat(path).catch(() => undefined);
      return nowConfigured?.dev === configuredIdentity.dev && nowConfigured.ino === configuredIdentity.ino &&
        nowConfigured.isDirectory() && !nowConfigured.isSymbolicLink() && nowRoot?.dev === rootIdentity.dev && nowRoot.ino === rootIdentity.ino &&
        now?.dev === identity.dev && now.ino === identity.ino && now.isDirectory() && !now.isSymbolicLink() &&
        await realpath(configuredRoot).catch(() => undefined) === root && await realpath(path).catch(() => undefined) === path;
    };
    if (!await owned()) throw new RunnerError('storage_unavailable');
    const anchor = process.platform === 'linux' ? `/proc/${process.pid}/fd/${handle.fd}` : path;
    return { root, path, anchor, owned, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}
