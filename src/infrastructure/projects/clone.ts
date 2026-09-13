import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { PreparedClone, ProjectCloner } from '../../application/clone-ports.js';
import { validCloneBranch, validCloneUrl, type CloneInput } from '../../domain/project-clone.js';
import { RunnerError } from '../../domain/contracts.js';

/** Clones use the server's SSH identity; credentials never pass through the editor. */
export class GitCloneAdapter implements ProjectCloner {
  private readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Clone root must be absolute');
    this.root = resolve(root);
  }

  async clone(input: CloneInput, _jobId: string, signal: AbortSignal): Promise<PreparedClone> {
    signal.throwIfAborted();
    // Independently constrain the filesystem segment even when called outside HTTP.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.name) || !validCloneUrl(input.url) ||
        (input.branch !== undefined && !validCloneBranch(input.branch))) throw new RunnerError('invalid_input');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootIdentity = await lstat(this.root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new RunnerError('storage_unavailable');
    const root = await realpath(this.root);
    const rootOwned = async () => {
      const current = await lstat(this.root).catch(() => undefined);
      return current?.dev === rootIdentity.dev && current.ino === rootIdentity.ino &&
        current.isDirectory() && !current.isSymbolicLink() &&
        await realpath(this.root).catch(() => undefined) === root;
    };
    if (!await rootOwned()) throw new RunnerError('storage_unavailable');
    const destination = join(root, input.name);
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new RunnerError('conflict');
      throw new RunnerError('storage_unavailable');
    }
    const identity = await lstat(destination);
    const destinationOwned = async () => {
      if (!await rootOwned()) return false;
      const current = await lstat(destination).catch(() => undefined);
      return current?.dev === identity.dev && current.ino === identity.ino &&
        current.isDirectory() && !current.isSymbolicLink();
    };
    const rollback = async () => {
      // A swapped root or destination is never ours to remove.
      if (await destinationOwned()) await rm(destination, { recursive: true, force: true });
    };
    try {
      if (!await destinationOwned()) throw new RunnerError('storage_unavailable');
      signal.throwIfAborted();
      await cloneGit(root, destination, input, signal);
      signal.throwIfAborted();
      if (!await destinationOwned()) throw new RunnerError('storage_unavailable');
      return { project: { id: input.name, name: input.name, path: destination }, rollback };
    } catch (error) {
      await rollback();
      throw error;
    }
  }
}

function cloneGit(cwd: string, destination: string, input: CloneInput, signal: AbortSignal): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o ConnectTimeout=15',
  });
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always', 'clone', '--no-recurse-submodules', '--template=', '--quiet'];
  if (input.branch) args.push('--branch', input.branch);
  args.push('--', input.url, destination);
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore'] });
    let stopped = false;
    const killGroup = () => {
      if (!child.pid || process.platform === 'win32') { child.kill('SIGKILL'); return; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    };
    const stop = () => { stopped = true; killGroup(); };
    const timer = setTimeout(stop, 10 * 60_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('exit', killGroup);
    child.once('error', () => { cleanup(); killGroup(); reject(new Error('Git clone could not start')); });
    child.once('close', code => {
      cleanup();
      if (signal.aborted) { reject(new Error('Git clone cancelled')); return; }
      if (stopped) { reject(new Error('Git clone timed out')); return; }
      if (code !== 0) { reject(new Error('Git clone failed; check repository access and branch on the server')); return; }
      resolveResult();
    });
  });
}
