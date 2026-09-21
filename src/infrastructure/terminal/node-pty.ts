import { spawn } from 'node-pty';
import { homedir, platform } from 'node:os';
import { pinnedSpawnPlan } from '../execution/pinned-spawn.js';
import { LinuxProcessTree } from '../execution/linux-process-tree.js';
import { RunnerError } from '../../domain/contracts.js';
import { PtyInput } from './pty-input.js';
import type { TerminalProcessFactory } from '../../application/terminal-ports.js';
/** Fixed interactive shell; caller bytes enter a PTY, never launch arguments. */
export class NodePtyFactory implements TerminalProcessFactory {
  async open(workspace: Parameters<TerminalProcessFactory['open']>[0], size: Parameters<TerminalProcessFactory['open']>[1], onData: (data: string) => void, onExit: (code: number | null) => void) {
    await workspace.revalidate();
    const env: Record<string, string> = { HOME: homedir(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']) if (process.env[key]) env[key] = process.env[key]!;
    const plan = pinnedSpawnPlan({ executable: '/bin/bash', args: ['-l'], cwd: workspace.cwd, cwdIdentity: workspace.identity });
    const pty = spawn(plan.executable, [...plan.args], { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: plan.cwd, env });
    let input: PtyInput | undefined; let tree: LinuxProcessTree | undefined; let observe: NodeJS.Timeout | undefined; let exited = false;
    const killGroup = () => { try { process.kill(-pty.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    const cleanup = () => { input?.close(); clearInterval(observe); try { tree?.kill(); } finally { killGroup(); } };
    try {
      // The pinned Unix adapter exposes its nonblocking master descriptor. Own the
      // writes ourselves: node-pty 1.1.0 leaves asynchronous writes alive on exit.
      const native = pty as unknown as { fd: number; _socket?: { destroyed: boolean; readable: boolean } };
      const socket = native._socket;
      if (!socket || typeof socket.destroyed !== 'boolean' || typeof socket.readable !== 'boolean') throw new RunnerError('storage_unavailable');
      input = new PtyInput(native.fd, undefined, () => !socket.destroyed && socket.readable);
      tree = platform() === 'linux' ? new LinuxProcessTree(pty.pid) : undefined;
      const data = pty.onData(onData);
      const exit = pty.onExit(event => { exited = true; data.dispose(); exit.dispose(); try { cleanup(); } catch { /* OS may already have reaped the group. */ } onExit(event.exitCode); });
      observe = setInterval(() => { try { tree?.observe(); } catch { /* Final cleanup repeats the bounded sweep. */ } }, 1000).unref();
      return {
        write(value: string) { input!.write(value); },
        resize(value: { cols: number; rows: number }) { pty.resize(value.cols, value.rows); },
        close() { data.dispose(); if (exited) return; cleanup(); },
      };
    } catch (error) { try { cleanup(); } finally { try { pty.kill('SIGKILL'); } catch { /* Preserve original initialization failure. */ } } throw error; }
  }
}
