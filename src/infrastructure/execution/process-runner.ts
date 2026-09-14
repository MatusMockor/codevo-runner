import { spawn } from 'node:child_process';
import { LinuxProcessTree } from './linux-process-tree.js';
import { StringDecoder } from 'node:string_decoder';
import type { ExecutionResult, OutputChannel } from '../../domain/execution.js';

/** Internal launch plan: never construct arguments/environment from HTTP fields. */
export type ProcessPlan = Readonly<{
  executable: string; args: readonly string[]; cwd: string; stdin: string;
  env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; outputBytes: number;
  onOutput: (channel: OutputChannel, text: string) => Promise<void>;
}>;

export async function runProcess(plan: ProcessPlan): Promise<ExecutionResult> {
  if (process.platform === 'win32') return { exitCode: null, error: 'unsupported_platform' };
  if (plan.signal.aborted) return { exitCode: null, error: 'cancelled' };
  return new Promise((resolve) => {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.cwd, env: plan.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: string | undefined;
    let bytes = 0;
    let delivery = Promise.resolve();
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let tree: LinuxProcessTree | undefined;
    try { if (process.platform === 'linux' && child.pid) tree = new LinuxProcessTree(child.pid); }
    catch { failure = 'process_cleanup_failed'; }
    const tracking = tree ? setInterval(() => {
      try { tree.observe(); } catch { stop('process_cleanup_failed'); }
    }, 100) : undefined;
    const killGroup = () => {
      try { tree?.kill(); } catch { failure = 'process_cleanup_failed'; }
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'process_cleanup_failed';
      }
    };
    const stop = (reason: string) => { failure ??= reason; killGroup(); };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('execution_timeout'), plan.timeoutMs);
    plan.signal.addEventListener('abort', abort, { once: true });
    // Cover cancellation between the initial check and listener registration.
    if (plan.signal.aborted) abort();
    if (failure) killGroup();
    child.once('error', () => { failure ??= 'provider_unavailable'; });
    child.stdin.on('error', () => { /* Early provider exit closes stdin normally. */ });
    for (const channel of ['stdout', 'stderr'] as const) {
      const stream = child[channel];
      stream.on('data', (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > plan.outputBytes) { stop('output_limit_exceeded'); return; }
        const text = decoders[channel].write(chunk);
        stream.pause();
        delivery = delivery.then(async () => {
          // Keep persisted events bounded and split only at Unicode code points.
          let part = '';
          let size = 0;
          for (const character of text) {
            const length = Buffer.byteLength(character);
            if (size + length > 8192) { await plan.onOutput(channel, part); part = ''; size = 0; }
            part += character; size += length;
          }
          if (part) await plan.onOutput(channel, part);
        }).catch(() => stop('output_persistence_failed')).finally(() => stream.resume());
      });
    }
    // Descendants must not outlive even a normally exited CLI parent or retain pipes.
    child.once('exit', killGroup);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      clearInterval(tracking);
      plan.signal.removeEventListener('abort', abort);
      killGroup();
      void delivery.then(async () => {
        if (!failure) {
          for (const channel of ['stdout', 'stderr'] as const) {
            const tail = decoders[channel].end();
            if (tail) await plan.onOutput(channel, tail);
          }
        }
      }).catch(() => { failure ??= 'output_persistence_failed'; }).finally(() => {
        resolve({ exitCode, ...(failure ? { error: failure } : {}) });
      });
    });
    child.stdin.end(plan.stdin);
  });
}
