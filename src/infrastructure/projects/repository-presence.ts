import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnerError } from '../../domain/contracts.js';
import { localGitEnvironment, runGitProcess, type GitIdentity, type GitProcessResult } from './git-command.js';

export type RepositoryStanding = 'root' | 'elsewhere' | 'outside';
type ProbedDirectory = Readonly<{ path: string; anchor: string; identity: GitIdentity }>;

const PROBE_MS = 3_000;
const PROBE_GRACE_MS = 500;
const STDERR_BYTES = 4096;
const NOT_A_REPOSITORY = 'fatal: not a git repository';
const NO_WORK_TREE = 'fatal: this operation must be run in a work tree';

export async function repositoryStanding(directory: ProbedDirectory, signal: AbortSignal): Promise<RepositoryStanding> {
  const gitDir = await probe(directory, ['rev-parse', '--git-dir'], signal);
  if (gitDir.code === 128) return unrooted(directory, gitDir.stderr);
  if (gitDir.code !== 0) throw new RunnerError('storage_unavailable');
  const top = await probe(directory, ['rev-parse', '--show-toplevel'], signal);
  if (top.code === 128 && top.stderr.startsWith(NO_WORK_TREE)) return 'elsewhere';
  if (top.code !== 0 || top.truncated) throw new RunnerError('storage_unavailable');
  const root = await realpath(top.stdout.toString('utf8').replace(/\n$/, '')).catch(() => undefined);
  if (root === undefined) throw new RunnerError('storage_unavailable');
  return root === directory.path ? 'root' : 'elsewhere';
}

async function probe(directory: ProbedDirectory, args: readonly string[], signal: AbortSignal): Promise<GitProcessResult> {
  signal.throwIfAborted();
  const result = await runGitProcess({ cwd: directory.path, args, env: localGitEnvironment(), timeoutMs: PROBE_MS, graceMs: PROBE_GRACE_MS,
    identity: directory.identity, signal, stderrBytes: STDERR_BYTES }).catch(() => undefined);
  signal.throwIfAborted();
  if (!result || result.timedOut || result.aborted) throw new RunnerError('storage_unavailable');
  return result;
}

async function unrooted(directory: ProbedDirectory, stderr: string): Promise<RepositoryStanding> {
  if (await gitEntry(directory) === 'present') return 'elsewhere';
  if (!stderr.startsWith(NOT_A_REPOSITORY)) throw new RunnerError('storage_unavailable');
  return 'outside';
}

async function gitEntry(directory: ProbedDirectory): Promise<'present' | 'absent'> {
  try {
    await lstat(join(directory.anchor, '.git'));
    return 'present';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw new RunnerError('storage_unavailable');
  }
}
