import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { LinuxProcessTree } from './linux-process-tree.js';
import { pinnedSpawnPlan } from './pinned-spawn.js';

export type UsageProcessOptions = Readonly<{
  claudeExecutable?: string; codexExecutable?: string; timeoutMs?: number;
}>;
type Protocol = Readonly<{
  initialInput: string;
  onLine?: (line: string, write: (value: unknown) => void) => boolean;
  /** Timer-driven turn of a line protocol; returning true completes like `onLine`. */
  onTick?: (write: (value: unknown) => void) => boolean;
  tickMs?: number;
}>;
/** `lineBytes` bounds one protocol line; parsed lines are then released instead of retained.
 * `rejectNonZeroExit` fails a completed line protocol whose process exited non-zero by itself. */
export type UsageProcessLaunch = Readonly<{
  cwd?: string; cwdIdentity?: Readonly<{ dev: number; ino: number }>; env?: NodeJS.ProcessEnv;
  outputBytes?: number; lineBytes?: number; ceilingMs?: number; rejectNonZeroExit?: boolean;
}>;

/** Fixed account commands run in the server user's home; a project checkout is used
 * only through an explicit launch whose pinned identity is verified before exec. */
export function runUsageProcess(program: string, args: readonly string[], protocol: Protocol,
  signal: AbortSignal, timeoutMs = 10_000, launch: UsageProcessLaunch = {}): Promise<string> {
  if (process.platform === 'win32' || signal.aborted) return Promise.reject(new Error('usage_unavailable'));
  const outputBytes = launch.outputBytes ?? 65_536;
  const lineBytes = protocol.onLine ? launch.lineBytes : undefined;
  const oversized = (text: string) => lineBytes !== undefined && Buffer.byteLength(text) > lineBytes;
  let plan: ReturnType<typeof pinnedSpawnPlan>;
  try {
    plan = pinnedSpawnPlan({ executable: program, args, cwd: launch.cwd ?? homedir(),
      ...(launch.cwdIdentity ? { cwdIdentity: launch.cwdIdentity } : {}) });
  } catch { return Promise.reject(new Error('usage_unavailable')); }
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.args], { cwd: plan.cwd, shell: false, detached: true,
      env: launch.env ?? { ...process.env, NO_COLOR: '1', CLICOLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let failed = false, completed = false, bytes = 0, stdout = '', lines = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let tree: LinuxProcessTree | undefined;
    let ticking: NodeJS.Timeout | undefined;
    const kill = () => {
      clearInterval(ticking);
      try { tree?.kill(); } catch { failed = true; }
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = true; }
    };
    const stop = () => { failed = true; kill(); };
    try { if (process.platform === 'linux' && child.pid) tree = new LinuxProcessTree(child.pid); }
    catch { stop(); }
    const tracking = tree ? setInterval(() => {
      try { tree?.observe(); } catch { stop(); }
    }, 100) : undefined;
    const timer = setTimeout(stop, Math.min(launch.ceilingMs ?? 10_000, Math.max(1, timeoutMs)));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', stop);
    child.stdin.on('error', () => { /* Provider failures are handled by exit/timeout. */ });
    const write = (value: unknown) => { if (!failed && !completed) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed || completed) return;
      bytes += chunk.length;
      if (bytes > outputBytes) return stop();
      let text: string;
      try { text = decoder.decode(chunk, { stream: true }); } catch { return stop(); }
      if (lineBytes === undefined) stdout += text;
      if (!protocol.onLine) return;
      lines += text;
      for (;;) {
        const end = lines.indexOf('\n');
        if (end < 0) break;
        const line = lines.slice(0, end);
        lines = lines.slice(end + 1);
        if (oversized(line)) { stop(); break; }
        try {
          if (protocol.onLine(line, write)) { completed = true; kill(); break; }
        } catch { stop(); break; }
      }
      if (!failed && !completed && oversized(lines)) stop();
    });
    const tick = protocol.onTick;
    if (tick && !failed) ticking = setInterval(() => {
      if (failed || completed) return;
      try {
        if (tick(write)) { completed = true; kill(); }
      } catch { stop(); }
    }, Math.max(1, protocol.tickMs ?? 100));
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputBytes) stop();
    });
    child.once('exit', kill);
    child.once('close', code => {
      clearTimeout(timer);
      clearInterval(tracking);
      clearInterval(ticking);
      signal.removeEventListener('abort', stop);
      kill();
      if (failed || (protocol.onLine ? !completed : code !== 0)) return reject(new Error('usage_unavailable'));
      // The runner's own SIGKILL after completion reports no exit code.
      if (launch.rejectNonZeroExit && code !== null && code !== 0) return reject(new Error('usage_unavailable'));
      try { resolve(stdout + decoder.decode()); } catch { reject(new Error('usage_unavailable')); }
    });
    child.stdin.write(protocol.initialInput);
    if (!protocol.onLine) child.stdin.end();
  });
}
