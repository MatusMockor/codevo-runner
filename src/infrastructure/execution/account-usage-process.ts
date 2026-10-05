import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { LinuxProcessTree } from './linux-process-tree.js';

export type UsageProcessOptions = Readonly<{
  claudeExecutable?: string; codexExecutable?: string; timeoutMs?: number;
}>;
type Protocol = Readonly<{
  initialInput: string;
  onLine?: (line: string, write: (value: unknown) => void) => boolean;
}>;

/** Fixed account commands run in the server user's home, never a project checkout. */
export function runUsageProcess(program: string, args: readonly string[], protocol: Protocol,
  signal: AbortSignal, timeoutMs = 10_000): Promise<string> {
  if (process.platform === 'win32' || signal.aborted) return Promise.reject(new Error('usage_unavailable'));
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { cwd: homedir(), shell: false, detached: true,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let failed = false, completed = false, bytes = 0, stdout = '', lines = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let tree: LinuxProcessTree | undefined;
    const kill = () => {
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
    const timer = setTimeout(stop, Math.min(10_000, Math.max(1, timeoutMs)));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', stop);
    child.stdin.on('error', () => { /* Provider failures are handled by exit/timeout. */ });
    const write = (value: unknown) => { if (!failed && !completed) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed || completed) return;
      bytes += chunk.length;
      if (bytes > 65_536) return stop();
      let text: string;
      try { text = decoder.decode(chunk, { stream: true }); } catch { return stop(); }
      stdout += text;
      if (!protocol.onLine) return;
      lines += text;
      for (;;) {
        const end = lines.indexOf('\n');
        if (end < 0) break;
        const line = lines.slice(0, end);
        lines = lines.slice(end + 1);
        try {
          if (protocol.onLine(line, write)) { completed = true; kill(); break; }
        } catch { stop(); break; }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) stop();
    });
    child.once('exit', kill);
    child.once('close', code => {
      clearTimeout(timer);
      clearInterval(tracking);
      signal.removeEventListener('abort', stop);
      kill();
      if (failed || (protocol.onLine ? !completed : code !== 0)) return reject(new Error('usage_unavailable'));
      try { resolve(stdout + decoder.decode()); } catch { reject(new Error('usage_unavailable')); }
    });
    child.stdin.write(protocol.initialInput);
    if (!protocol.onLine) child.stdin.end();
  });
}
