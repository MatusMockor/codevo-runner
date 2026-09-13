import { spawn } from 'node:child_process';
const OUTPUT_LIMIT = 256 * 1024;

export function git(cwd: string, args: readonly string[], signal?: AbortSignal, identity?: Readonly<{ dev: number; ino: number }>): Promise<{text: string; truncated: boolean; bytes: Buffer}> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args];
    // Holding the kernel cwd prevents A→B→A pathname replacement from redirecting Git.
    const executable = identity ? 'python3' : 'git';
    const launchArgs = identity ? ['-I', '-S', '-c', PINNED_GIT] : gitArgs;
    const child = spawn(executable, launchArgs, { cwd: identity ? '/' : cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => { /* Early process rejection closes stdin. */ });
    child.stdin.end(identity ? JSON.stringify({ cwd, identity, args: gitArgs }) : undefined);

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
      resolveResult({ bytes: Buffer.concat(chunks), text: new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated }), truncated });
    });
  });
}

// This fixed helper is bundled by TypeScript; callers cannot supply executable source.
const PINNED_GIT = String.raw`
import json, os, sys
try:
    request = json.load(sys.stdin)
    root = os.open(request['cwd'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(root)
    if info.st_dev != request['identity']['dev'] or info.st_ino != request['identity']['ino']:
        sys.exit(2)
    os.fchdir(root)
    os.execvpe('git', ['git'] + request['args'], os.environ)
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(2)
`;
