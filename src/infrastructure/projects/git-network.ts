import { RunnerError } from '../../domain/contracts.js';
import { validCloneUrl } from '../../domain/project-clone.js';
import { GIT_SYNC_LIMITS } from '../../domain/git-sync.js';
import { prepareCloneProviderAuth } from './clone-provider-auth.js';
import type { GitWorkdir } from '../../application/git-sync-ports.js';
import { localGitEnvironment, runGitProcess, type GitProcessResult } from './git-command.js';

export const GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o ConnectTimeout=15';

export const NETWORK_BASE_CONFIG: readonly string[] = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
]);

export const SYNC_CONFIG: readonly string[] = Object.freeze([
  ...NETWORK_BASE_CONFIG,
  '-c', 'http.followRedirects=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'fetch.recurseSubmodules=false',
  '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'merge.autoStash=false', '-c', 'diff.external=',
]);

export function networkGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return Object.assign(env, {
    LC_ALL: 'C', LANGUAGE: '', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_SSH_COMMAND,
  });
}

export type OriginRemote = Readonly<{ fetchUrl: string; pushUrl: string }>;

export function localGit(workdir: GitWorkdir, args: readonly string[], signal?: AbortSignal, timeoutMs: number = GIT_SYNC_LIMITS.localMs, stderrBytes = 0): Promise<GitProcessResult> {
  return runGitProcess({ cwd: workdir.cwd, identity: workdir.identity, args: [...SYNC_CONFIG, ...args],
    env: localGitEnvironment(), timeoutMs, stderrBytes, ...(signal ? { signal } : {}) }).then(result => {
    signal?.throwIfAborted();
    if (result.timedOut) throw new RunnerError('git_timeout');
    if (result.aborted) throw new RunnerError('busy');
    return result;
  }, spawnFailure(signal));
}

function spawnFailure(signal?: AbortSignal) {
  return (error: unknown): never => {
    signal?.throwIfAborted();
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('conflict');
  };
}

async function configValues(workdir: GitWorkdir, key: string, signal?: AbortSignal): Promise<readonly string[]> {
  const result = await localGit(workdir, ['config', '--local', '--no-includes', '--get-all', key], signal);
  if (result.code === 1) return [];
  if (result.code !== 0 || result.truncated) throw new RunnerError('git_remote_unsupported');
  return result.stdout.toString('utf8').replace(/\n$/, '').split('\n');
}

export async function readOrigin(workdir: GitWorkdir, signal?: AbortSignal): Promise<OriginRemote> {
  const urls = await configValues(workdir, 'remote.origin.url', signal);
  const pushUrls = await configValues(workdir, 'remote.origin.pushurl', signal);
  if (urls.length === 0) throw new RunnerError('git_no_remote');
  if (urls.length !== 1 || pushUrls.length > 1 || ![...urls, ...pushUrls].every(validCloneUrl))
    throw new RunnerError('git_remote_unsupported');
  return { fetchUrl: urls[0]!, pushUrl: pushUrls[0] ?? urls[0]! };
}

export async function networkGit(workdir: GitWorkdir, url: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<GitProcessResult> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let providerAuth: readonly string[];
  try { providerAuth = await prepareCloneProviderAuth(url, combined); }
  catch {
    signal?.throwIfAborted();
    throw new RunnerError(deadline.aborted ? 'git_timeout' : 'git_remote_unavailable');
  }
  const result = await runGitProcess({ cwd: workdir.cwd, identity: workdir.identity, args: [...SYNC_CONFIG, ...providerAuth, ...args],
    env: networkGitEnvironment(), timeoutMs, signal: combined, stderrBytes: GIT_SYNC_LIMITS.stderrBytes }).catch(spawnFailure(signal));
  signal?.throwIfAborted();
  if (result.timedOut || deadline.aborted) throw new RunnerError('git_timeout');
  return result;
}
