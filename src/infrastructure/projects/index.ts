import { spawn } from 'node:child_process';
import { mkdir, realpath, lstat, writeFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProjectRegistry, ProjectWorkspace } from '../../application/execution-ports.js';
import { isId, RunnerError } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';

const OUTPUT_LIMIT = 256 * 1024;

/** Host-admin registration only. Public listings never expose filesystem paths. */
export class ConfiguredProjectRegistry implements ProjectRegistry {
  private readonly projects = new Map<string, RegisteredProject>();
  constructor(projects: readonly RegisteredProject[]) {
    for (const project of projects) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(project.id) || !project.name.trim() ||
          project.name.length > 100 || !isAbsolute(project.path) || this.projects.has(project.id))
        throw new Error('Invalid or duplicate project registration');
      this.projects.set(project.id, Object.freeze({ ...project, path: resolve(project.path) }));
    }
  }
  async list() { return [...this.projects.values()].map(({ id, name }) => ({ id, name })); }
  async get(id: string): Promise<RegisteredProject> {
    const project = this.projects.get(id);
    if (!project) throw new RunnerError('not_found');
    return project;
  }
}

/** A worktree isolates normal edits, not malicious processes with the same Unix identity. */
export class GitProjectWorkspace implements ProjectWorkspace {
  private readonly root: string;
  private readonly baselines: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'workspaces');
    this.baselines = resolve(dataDir, 'workspace-baselines');
  }

  async prepare(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<string> {
    const cwd = this.taskPath(taskId);
    signal?.throwIfAborted();
    const source = await realpath(project.path);
    const top = (await git(source, ['rev-parse', '--show-toplevel'], signal)).text.trim();
    if (await realpath(top) !== source) throw new Error('Registered project must be a Git working tree root');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Workspace root must not contain symlinks');
    try {
      await lstat(cwd);
      throw new RunnerError('conflict');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const base = (await git(source, ['rev-parse', '--verify', 'HEAD'], signal)).text.trim();
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('Invalid Git revision');
    await mkdir(this.baselines, { recursive: true, mode: 0o700 });
    if ((await lstat(this.baselines)).isSymbolicLink()) throw new Error('Baseline root must not contain symlinks');
    await writeFile(join(this.baselines, taskId), base, { flag: 'wx', mode: 0o600 });
    // Detached HEAD keeps task edits/commits away from the source branch.
    await git(source, ['worktree', 'add', '--detach', '--', cwd, base], signal);
    signal?.throwIfAborted();
    return cwd;
  }

  async diff(taskId: string): Promise<{ patch: string; truncated: boolean; untrackedFiles: readonly string[] }> {
    const cwd = this.taskPath(taskId);
    try {
      if (!(await lstat(cwd)).isDirectory()) throw new RunnerError('not_found');
    } catch { throw new RunnerError('not_found'); }
    const base = await readFile(join(this.baselines, taskId), 'utf8');
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new RunnerError('storage_unavailable');
    const patch = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', base, '--']);
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    const filenames = untracked.text.split('\0');
    // A truncated last name is not a real filename.
    filenames.pop();
    return { patch: patch.text, truncated: patch.truncated || untracked.truncated, untrackedFiles: filenames };
  }

  private taskPath(taskId: string) {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    return join(this.root, taskId);
  }
}

function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<{text: string; truncated: boolean}> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=', ...args], { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    let stopped = false;
    const killGroup = () => {
      if (process.platform === 'win32' || !child.pid) { child.kill('SIGKILL'); return; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
    };
    const stop = () => { stopped = true; killGroup(); };
    // Exit precedes close: descendants may still hold stdout/stderr open after Git exits.
    child.once('exit', killGroup);
    const timer = setTimeout(stop, 30_000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      const keep = Math.min(chunk.length, OUTPUT_LIMIT - size);
      if (keep) chunks.push(chunk.subarray(0, keep));
      size += keep;
      if (keep < chunk.length) truncated = true;
    });
    child.stderr.resume();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { killGroup(); cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (stopped || signal?.aborted) return reject(signal?.reason ?? new Error('Git operation timed out'));
      if (code !== 0) return reject(new Error(`Git operation failed (${code})`));
      resolveResult({ text: new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated }), truncated });
    });
  });
}
