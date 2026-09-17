import { spawn, type IPty } from 'node-pty';
import { homedir, platform } from 'node:os';
import { pinnedSpawnPlan } from '../execution/pinned-spawn.js';
import { LinuxProcessTree } from '../execution/linux-process-tree.js';
import { RunnerError } from '../../domain/contracts.js';
import type { TerminalProcessFactory } from '../../application/terminal-ports.js';
/** Pinned node-pty Unix adapter: its public write API has no backpressure signal. */
function queuedBytes(pty: IPty): number {
  const stream = (pty as unknown as { _writeStream?: { _writeQueue?: unknown } })._writeStream;
  if (!Array.isArray(stream?._writeQueue) || stream._writeQueue.length > 4096) throw new RunnerError('storage_unavailable');
  let total = 0;
  for (const entry of stream._writeQueue as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new RunnerError('storage_unavailable');
    const item = entry as { buffer?: unknown; offset?: unknown };
    if (!Buffer.isBuffer(item.buffer) || typeof item.offset !== 'number' || !Number.isSafeInteger(item.offset) || item.offset < 0 || item.offset > item.buffer.length) throw new RunnerError('storage_unavailable');
    total += item.buffer.length - item.offset;
  }
  return total;
}
/** Fixed interactive shell; caller bytes enter a PTY, never launch arguments. */
export class NodePtyFactory implements TerminalProcessFactory {
  async open(workspace: Parameters<TerminalProcessFactory['open']>[0], size: Parameters<TerminalProcessFactory['open']>[1], onData: (data: string) => void, onExit: (code: number | null) => void) {
    await workspace.revalidate();
    const env: Record<string, string> = { HOME: homedir(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']) if (process.env[key]) env[key] = process.env[key]!;
    const plan = pinnedSpawnPlan({ executable: '/bin/bash', args: ['-l'], cwd: workspace.cwd, cwdIdentity: workspace.identity });
    const pty = spawn(plan.executable, [...plan.args], { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: plan.cwd, env });
    let tree: LinuxProcessTree | undefined; let observe: NodeJS.Timeout | undefined; let exited = false;
    const killGroup = () => { try { process.kill(-pty.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    const cleanup = () => { clearInterval(observe); try { tree?.kill(); } finally { killGroup(); } };
    try {
      queuedBytes(pty); // Fail closed on incompatible native dependency changes.
      tree = platform() === 'linux' ? new LinuxProcessTree(pty.pid) : undefined;
      const data = pty.onData(onData);
      const exit = pty.onExit(event => { exited = true; data.dispose(); exit.dispose(); try { cleanup(); } catch { /* OS may already have reaped the group. */ } onExit(event.exitCode); });
      observe = setInterval(() => { try { tree?.observe(); } catch { /* Final cleanup repeats the bounded sweep. */ } }, 1000).unref();
      return {
        write(value: string) { if (queuedBytes(pty) + Buffer.byteLength(value) > 262_144) throw new RunnerError('busy'); pty.write(value); },
        resize(value: { cols: number; rows: number }) { pty.resize(value.cols, value.rows); },
        close() { data.dispose(); if (exited) return; cleanup(); },
      };
    } catch (error) { try { cleanup(); } finally { try { pty.kill('SIGKILL'); } catch { /* Preserve original initialization failure. */ } } throw error; }
  }
}
