import { pinnedSpawnPlan } from './pinned-spawn.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ExecutionResult, OutputChannel } from '../../domain/execution.js';
import { LIMITS } from '../../domain/contracts.js';
import { INSTRUCTION_LIMITS } from '../../domain/instructions.js';
import { LinuxProcessTree } from './linux-process-tree.js';

export type InteractiveSend = (value: unknown) => Promise<void>;
export interface InteractiveProtocol {
  start(send: InteractiveSend, fail?: (error: string) => void): Promise<void>;
  receive(frame: Record<string, unknown>, send: InteractiveSend, fail?: (error: string) => void): Promise<ExecutionResult | undefined>;
}
export interface InteractiveProcessPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cwdIdentity?: Readonly<{ dev: number; ino: number }>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Claude print results may precede background-agent completion and later results. */
  readonly completion?: 'provider-exit';
  readonly onOutput: (channel: OutputChannel, text: string) => Promise<void>;
}
const FRAME_BYTES = 8 * 1024 * 1024;
export const INTERACTIVE_INPUT_BYTES = LIMITS.attachmentsPerTask * 4 * Math.ceil(LIMITS.attachmentBytes / 3)
  + 6 * (LIMITS.textBytes * LIMITS.parts + INSTRUCTION_LIMITS.totalBytes) + 1024 * 1024;

/** Owns one persistent provider and its descendants; no shell and no unbounded frame queue. */
export async function runInteractiveProcess(plan: InteractiveProcessPlan, protocol: InteractiveProtocol): Promise<ExecutionResult> {
  if (plan.signal.aborted) return { exitCode: null, error: 'cancelled' };
  if (process.platform === 'win32') return { exitCode: null, error: 'unsupported_platform' };
  let launch;
  try { launch = pinnedSpawnPlan(plan); } catch { return { exitCode: null, error: 'workspace_identity_invalid' }; }
  return new Promise(resolve => {
    const child = spawn(launch.executable, [...launch.args], { cwd: launch.cwd, env: plan.env,
      shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let result: ExecutionResult | undefined;
    let providerResult: ExecutionResult | undefined;
    let closed = false;
    let pending = '';
    let pendingBytes = 0;
    let stderrDelivery = Promise.resolve();
    let stdoutDelivery = Promise.resolve();
    let tree: LinuxProcessTree | undefined;
    const decoder = new StringDecoder('utf8');
    const kill = () => {
      try { tree?.kill(); } catch { result = { exitCode: null, error: 'process_cleanup_failed' }; }
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') result = { exitCode: null, error: 'process_cleanup_failed' }; }
    };
    const finish = (value: ExecutionResult) => { if (!result && !closed) {
      result = value; kill();
      // A paused pipe may never emit close on Linux while an async receiver is waiting.
      // No further frames are authoritative after a terminal result or cancellation.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    } };
    const fail = (error: string) => finish({ exitCode: null, error });
    try { if (process.platform === 'linux' && child.pid) tree = new LinuxProcessTree(child.pid); }
    catch { fail('process_cleanup_failed'); }
    const tracking = tree ? setInterval(() => { try { tree?.observe(); } catch { fail('process_cleanup_failed'); } }, 100) : undefined;
    const timer = plan.timeoutMs > 0 ? setTimeout(() => fail('execution_timeout'), plan.timeoutMs) : undefined;
    const abort = () => fail('cancelled');
    plan.signal.addEventListener('abort', abort, { once: true });
    if (plan.signal.aborted) abort();
    const send: InteractiveSend = async value => {
      if (closed || result || plan.signal.aborted) throw new Error('interactive_closed');
      const data = JSON.stringify(value) + '\n';
      // Images can exceed inbound event size, but remain bounded by the attachment contract.
      if (Buffer.byteLength(data) > INTERACTIVE_INPUT_BYTES) throw new Error('interactive_input_limit');
      await new Promise<void>((accept, reject) => child.stdin.write(data, error => error ? reject(error) : accept()));
    };
    child.stdin.on('error', () => { if (!result) fail('provider_input_failed'); });
    child.once('error', () => fail('provider_unavailable'));
    child.once('spawn', () => { void protocol.start(send, fail).catch(() => fail('provider_protocol_failed')); });
    child.stdout.on('data', (chunk: Buffer) => {
      child.stdout.pause();
      stdoutDelivery = (async () => {
        const text = decoder.write(chunk);
        let offset = 0;
        while (offset < text.length && !result && !closed) {
          const newline = text.indexOf('\n', offset);
          const end = newline < 0 ? text.length : newline;
          const piece = text.slice(offset, end);
          pendingBytes += Buffer.byteLength(piece);
          if (pendingBytes > FRAME_BYTES) throw new Error('frame_limit');
          pending += piece;
          if (newline < 0) break;
          const line = pending; pending = ''; pendingBytes = 0; offset = newline + 1;
          if (!line.trim()) continue;
          const frame: unknown = JSON.parse(line);
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid_frame');
          const completed = await protocol.receive(frame as Record<string, unknown>, send, fail);
          if (completed) {
            if (plan.completion === 'provider-exit' && !completed.error && completed.exitCode === 0) {
              const first = providerResult === undefined;
              providerResult = completed;
              if (first) child.stdin.end();
            } else finish(completed);
          }
        }
      })().catch(() => fail('provider_protocol_failed')).finally(() => { if (!closed && !result) child.stdout.resume(); });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      child.stderr.pause();
      stderrDelivery = emitInteractiveOutput(plan.onOutput, 'stderr', chunk.toString('utf8'))
        .catch(() => fail('output_persistence_failed')).finally(() => { if (!closed && !result) child.stderr.resume(); });
    });
    child.once('exit', kill);
    child.once('close', exitCode => {
      clearTimeout(timer); clearInterval(tracking); kill();
      // Drain already accepted persistence before task completion; a broken adapter cannot retain ownership forever.
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const boundedDrain = new Promise<void>(accept => { drainTimer = setTimeout(() => {
        result ??= { exitCode: null, error: 'output_persistence_failed' }; accept();
      }, 1000); });
      void Promise.race([Promise.all([stdoutDelivery, stderrDelivery]), boundedDrain]).finally(() => {
        clearTimeout(drainTimer); closed = true; pending = '';
        plan.signal.removeEventListener('abort', abort);
        resolve(result ?? (providerResult
          ? { ...providerResult, ...(exitCode === 0 ? {} : { exitCode, error: providerResult.error ?? 'provider_reported_failure' }) }
          : { exitCode, error: 'provider_result_missing' }));
      });
    });
  });
}

export async function emitInteractiveOutput(onOutput: InteractiveProcessPlan['onOutput'], channel: OutputChannel, text: string): Promise<void> {
  let part = ''; let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 8192) { await onOutput(channel, part); part = ''; bytes = 0; }
    part += character; bytes += size;
  }
  if (part) await onOutput(channel, part);
}
