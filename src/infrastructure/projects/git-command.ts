import { spawn } from 'node:child_process';
const OUTPUT_LIMIT = 256 * 1024;
const STOP_GRACE_MS = 2_000;

export type GitIdentity = Readonly<{ dev: number; ino: number }>;
export type GitProcessRequest = Readonly<{
  cwd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  identity?: GitIdentity;
  signal?: AbortSignal;
  stderrBytes?: number;
  graceMs?: number;
}>;
export type GitProcessResult = Readonly<{
  code: number | null; stdout: Buffer; truncated: boolean; stderr: string; timedOut: boolean; aborted: boolean;
}>;

export function localGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return Object.assign(env, { LC_ALL: 'C', LANGUAGE: '', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
}

export function git(cwd: string, args: readonly string[], signal?: AbortSignal, identity?: GitIdentity): Promise<{text: string; truncated: boolean; bytes: Buffer}> {
  signal?.throwIfAborted();
  const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args];
  return runGitProcess({ cwd, args: gitArgs, env: localGitEnvironment(), timeoutMs: 30_000, ...(identity ? { identity } : {}), ...(signal ? { signal } : {}) })
    .then(result => {
      if (result.timedOut || result.aborted) throw signal?.reason ?? new Error('Git operation timed out');
      if (result.code !== 0) throw new Error(`Git operation failed (${result.code})`);
      return { bytes: result.stdout, text: new TextDecoder().decode(result.stdout, { stream: result.truncated }), truncated: result.truncated };
    });
}

export function runGitProcess(request: GitProcessRequest): Promise<GitProcessResult> {
  const { cwd, args, env, identity, signal } = request;
  return new Promise((resolveResult, reject) => {
    // Holding the kernel cwd prevents A→B→A pathname replacement from redirecting Git.
    const executable = identity ? 'python3' : 'git';
    const launchArgs = identity ? ['-I', '-S', '-c', PINNED_GIT] : [...args];
    const child = spawn(executable, launchArgs, { cwd: identity ? '/' : cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => { /* Early process rejection closes stdin. */ });
    child.stdin.end(identity ? JSON.stringify({ cwd, identity, args }) : undefined);

    let size = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    const stderrLimit = request.stderrBytes ?? 0;
    const errors: Buffer[] = [];
    let errorSize = 0;
    let timedOut = false;
    let aborted = false;
    const signalGroup = (name: NodeJS.Signals) => {
      if (process.platform === 'win32' || !child.pid) { child.kill(name); return; }
      try { process.kill(-child.pid, name); } catch { /* Process already exited. */ }
    };
    const killGroup = () => signalGroup('SIGKILL');
    let escalation: NodeJS.Timeout | undefined;
    // Git removes its lock files on SIGTERM; SIGKILL follows only if it does not exit in time.
    const stop = () => {
      if (escalation) return;
      signalGroup('SIGTERM');
      escalation = setTimeout(killGroup, request.graceMs ?? STOP_GRACE_MS);
    };
    const timeout = () => { timedOut = true; stop(); };
    const abort = () => { aborted = true; stop(); };
    // Exit precedes close: descendants may still hold stdout/stderr open after Git exits.
    child.once('exit', killGroup);
    const timer = setTimeout(timeout, request.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      const keep = Math.min(chunk.length, OUTPUT_LIMIT - size);
      if (keep) chunks.push(chunk.subarray(0, keep));
      size += keep;
      if (keep < chunk.length) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const keep = Math.min(chunk.length, stderrLimit - errorSize);
      if (keep > 0) { errors.push(chunk.subarray(0, keep)); errorSize += keep; }
    });
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { killGroup(); cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      resolveResult({ code, stdout: Buffer.concat(chunks), truncated, stderr: Buffer.concat(errors).toString('utf8'),
        timedOut, aborted: aborted || Boolean(signal?.aborted) });
    });
  });
}

// This fixed helper is bundled by TypeScript; callers cannot supply executable source.
const PINNED_GIT = String.raw`
import json, os, sys
try:
    request = json.load(sys.stdin.buffer)
    root = os.open(request['cwd'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(root)
    if info.st_dev != request['identity']['dev'] or info.st_ino != request['identity']['ino']:
        sys.exit(2)
    os.fchdir(root)
    os.execvpe('git', ['git'] + request['args'], os.environ)
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(2)
`;
