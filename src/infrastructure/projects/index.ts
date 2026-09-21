import { constants } from 'node:fs';
import { mkdir, realpath, lstat, writeFile, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProjectRegistry, ProjectWorkspace } from '../../application/execution-ports.js';
import { isId, RunnerError } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';

import { ProjectRepositoryIdentity } from './repository-identity.js';
import { git } from './git-command.js';
import { captureWorkspace, loadMetadata, saveMetadata, validateWorkspace } from './workspace-metadata.js';
import { listWorkspaceFiles, readWorkspaceFileDiff } from './workspace-files.js';
import { validateWorkspacePath } from '../../domain/workspace-files.js';

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
  private readonly metadata: string;
  private reviews = 0;
  private readonly repositoryIdentities = new ProjectRepositoryIdentity();
  repositoryIdentity(project: RegisteredProject, signal?: AbortSignal) {
    return this.repositoryIdentities.read(project, signal);
  }
  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'workspaces');
    this.baselines = resolve(dataDir, 'workspace-baselines');
    this.metadata = resolve(dataDir, 'workspace-metadata');
  }

  async prepare(project: RegisteredProject, taskId: string, signal?: AbortSignal, isolation: 'in-place' | 'worktree' = 'worktree'): Promise<string> {
    const cwd = this.taskPath(taskId);
    if (isolation !== 'in-place' && isolation !== 'worktree') throw new RunnerError('invalid_input');
    signal?.throwIfAborted();
    const metadata = await captureWorkspace(project, isolation, signal);
    const source = metadata.source;
    const top = (await git(source, ['rev-parse', '--show-toplevel'], signal, metadata.sourceIdentity)).text.trim();
    if (await realpath(top) !== source) throw new Error('Registered project must be a Git working tree root');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Workspace root must not contain symlinks');
    try {
      await lstat(cwd);
      throw new RunnerError('conflict');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const base = (await git(source, ['rev-parse', '--verify', 'HEAD'], signal, metadata.sourceIdentity)).text.trim();
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('Invalid Git revision');
    await mkdir(this.baselines, { recursive: true, mode: 0o700 });
    if ((await lstat(this.baselines)).isSymbolicLink()) throw new Error('Baseline root must not contain symlinks');
    await writeFile(join(this.baselines, taskId), base, { flag: 'wx', mode: 0o600 });
    await validateWorkspace(metadata, project, signal);
    await saveMetadata(this.metadata, taskId, metadata);
    // In-place deliberately preserves every tracked and untracked source edit.
    if (isolation === 'worktree') await git(source, ['worktree', 'add', '--detach', '--', cwd, base], signal, metadata.sourceIdentity);
    await validateWorkspace(metadata, project, signal);
    signal?.throwIfAborted();
    return isolation === 'in-place' ? source : cwd;
  }

  async resume(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<string> {
    let cwd = this.taskPath(workspaceTaskId);
    const metadata = await loadMetadata(this.metadata, workspaceTaskId);
    if (metadata) {
      await validateWorkspace(metadata, project, signal);
      if (metadata.mode === 'in-place') cwd = metadata.source;
    }
    signal?.throwIfAborted();
    const source = await realpath(project.path);
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(this.baselines)).isSymbolicLink() ||
        !(await lstat(cwd)).isDirectory() || (await lstat(cwd)).isSymbolicLink()) throw new RunnerError('conflict');
    const canonicalCwd = await realpath(cwd);
    if (metadata?.mode !== 'in-place' && canonicalCwd !== join(await realpath(this.root), workspaceTaskId)) throw new RunnerError('conflict');
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).text.trim();
    if (await realpath(top) !== canonicalCwd) throw new RunnerError('conflict');
    const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).text.trim();
    const sourceCommon = (await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).text.trim();
    if (await realpath(common) !== await realpath(sourceCommon)) throw new RunnerError('conflict');
    const basePath = join(this.baselines, workspaceTaskId);
    if (!(await lstat(basePath)).isFile() || (await lstat(basePath)).isSymbolicLink()) throw new RunnerError('conflict');
    const base = await readBaseline(basePath);
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new RunnerError('conflict');
    await git(cwd, ['cat-file', '-e', `${base}^{commit}`], signal);
    if (metadata) await validateWorkspace(metadata, project, signal);
    signal?.throwIfAborted();
    return cwd;
  }

  async identity(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<{ dev: number; ino: number }> {
    this.taskPath(taskId);
    const metadata = await loadMetadata(this.metadata, taskId);
    const cwd = await this.resume(project, taskId, signal);
    const before = await lstat(cwd);
    await this.resume(project, taskId, signal);
    const after = await lstat(cwd);
    const expected = metadata?.mode === 'in-place' ? metadata.sourceIdentity : before;
    if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() ||
        before.dev !== expected.dev || before.ino !== expected.ino || after.dev !== expected.dev || after.ino !== expected.ino)
      throw new RunnerError('conflict');
    signal?.throwIfAborted();
    return { dev: expected.dev, ino: expected.ino };
  }

  async diff(taskId: string, registeredProject?: RegisteredProject): Promise<{ patch: string; truncated: boolean; untrackedFiles: readonly string[] }> {
    let cwd = this.taskPath(taskId);
    const metadata = await loadMetadata(this.metadata, taskId);
    const project = registeredProject ?? (metadata ? { id: metadata.projectId, name: metadata.projectId, path: metadata.source } : undefined);
    if (project) cwd = await this.resume(project, taskId);
    try {
      if (!(await lstat(cwd)).isDirectory()) throw new RunnerError('not_found');
    } catch { throw new RunnerError('not_found'); }
    const base = await readBaseline(join(this.baselines, taskId));
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new RunnerError('storage_unavailable');
    const identity = project ? await this.identity(project, taskId) : await lstat(cwd);
    const patch = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', base, '--'], undefined, identity);
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--'], undefined, identity);
    const filenames = untracked.text.split('\0');
    // A truncated last name is not a real filename.
    filenames.pop();
    if (project) await this.resume(project, taskId);
    return { patch: patch.text, truncated: patch.truncated || untracked.truncated, untrackedFiles: filenames };
  }

  files(project: RegisteredProject, taskId: string) {
    return this.review(project, taskId, (cwd, base, _identity, signal) => listWorkspaceFiles(cwd, base, signal, _identity));
  }

  fileDiff(project: RegisteredProject, taskId: string, path: string) {
    validateWorkspacePath(path);
    return this.review(project, taskId, (cwd, base, identity, signal) => readWorkspaceFileDiff(cwd, identity, base, path, signal));
  }

  private async review<T>(project: RegisteredProject, taskId: string,
    operation: (cwd: string, base: string, identity: { dev: number; ino: number }, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.reviews >= 2) throw new RunnerError('busy');
    this.reviews++;
    const signal = AbortSignal.timeout(10_000);
    try {
      const cwd = await this.resume(project, taskId, signal);
      const identity = await lstat(cwd);
      const canonical = await realpath(cwd);
      const baselinePath = join(this.baselines, taskId);
      const baseline = await open(baselinePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const baselineIdentity = await baseline.stat();
        if (!baselineIdentity.isFile() || ![40, 64].includes(baselineIdentity.size)) throw new RunnerError('conflict');
        const buffer = Buffer.alloc(64);
        const read = await baseline.read(buffer, 0, buffer.length, 0);
        const base = buffer.subarray(0, read.bytesRead).toString('utf8');
        if (!/^[0-9a-f]{40,64}$/.test(base)) throw new RunnerError('conflict');
        const result = await operation(canonical, base, identity, signal);
        await this.resume(project, taskId, signal);
        const current = await lstat(cwd);
        const currentBaseline = await lstat(baselinePath);
        if (current.dev !== identity.dev || current.ino !== identity.ino || await realpath(cwd) !== canonical ||
            currentBaseline.dev !== baselineIdentity.dev || currentBaseline.ino !== baselineIdentity.ino ||
            currentBaseline.mtimeMs !== baselineIdentity.mtimeMs || currentBaseline.size !== baselineIdentity.size)
          throw new RunnerError('conflict');
        signal.throwIfAborted();
        return result;
      } finally { await baseline.close(); }
    } finally { this.reviews--; }
  }

  private taskPath(taskId: string) {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    return join(this.root, taskId);
  }
}

async function readBaseline(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || ![40, 64].includes(info.size)) throw new RunnerError('conflict');
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
