import { readFileSync, readdirSync } from 'node:fs';
import { PROCESS_TREE_LIMIT, outranksProcessFailure } from '../../domain/process-observation.js';
import type { OwnedProcess, OwnedProcessTree } from '../../domain/process-ownership.js';

interface Identity { readonly pid: number; readonly start: string; readonly parent: number }
export type ProcReader = Readonly<{ read(path: string): string; list(path: string): string[] }>;
const LIMIT = 4096;
const PROC: ProcReader = { read: path => readFileSync(path, 'utf8'), list: path => readdirSync(path) };
const gone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Linux ownership uses kernel start times, never a recycled PID alone. */
export class LinuxProcessTree implements OwnedProcessTree {
  private readonly owned = new Map<number, Identity>();
  constructor(root: number, private readonly proc: ProcReader = PROC) {
    const identity = this.identity(root);
    if (identity) this.owned.set(root, identity);
  }

  private identity(pid: number): Identity | undefined {
    try {
      const stat = this.proc.read(`/proc/${pid}/stat`);
      // comm can contain spaces and parentheses; fields following its final ')' are fixed.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      return start && /^\d+$/.test(start) ? { pid, start, parent: Number(fields[1]) } : undefined;
    } catch (error) {
      if (gone(error)) return undefined;
      throw error;
    }
  }

  private current(identity: Identity): boolean {
    return this.identity(identity.pid)?.start === identity.start;
  }

  private signal(identity: Identity, signal: NodeJS.Signals): void {
    if (!this.current(identity)) return;
    try { process.kill(identity.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  /** Request parent suspension before discovery to narrow concurrent-fork races.
   * Kernel cgroups are required to contain arbitrary daemonization between observations. */
  private collect(freeze: boolean): void {
    let deferred = undefined as { readonly error: unknown } | undefined;
    const defer = (error: unknown) => { if (!deferred || outranksProcessFailure(error, deferred.error)) deferred = { error }; };
    const current = (identity: Identity): boolean | undefined => {
      try { return this.current(identity); } catch (error) { defer(error); return undefined; }
    };
    for (const [pid, identity] of this.owned) {
      if (current(identity) === false) this.owned.delete(pid);
    }
    const queue = [...this.owned.values()];
    const visited = new Set<number>();
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      if (visited.has(parent.pid) || !current(parent)) continue;
      visited.add(parent.pid);
      try { if (freeze) this.signal(parent, 'SIGSTOP'); } catch (error) { defer(error); }
      let threads: string[];
      try { threads = this.proc.list(`/proc/${parent.pid}/task`); }
      catch (error) {
        if (!gone(error)) defer(error);
        continue;
      }
      if (threads.length > LIMIT) throw new Error(PROCESS_TREE_LIMIT);
      for (const thread of threads) {
        let children: string;
        try { children = this.proc.read(`/proc/${parent.pid}/task/${thread}/children`); }
        catch (error) {
          if (!gone(error)) defer(error);
          continue;
        }
        if (children.length > LIMIT * 16) throw new Error(PROCESS_TREE_LIMIT);
        for (const raw of children.trim().split(/\s+/)) {
          if (!/^\d+$/.test(raw)) continue;
          let child: Identity | undefined;
          try { child = this.identity(Number(raw)); } catch (error) { defer(error); continue; }
          if (!child || child.parent !== parent.pid || !current(parent) || this.owned.get(child.pid)?.start === child.start) continue;
          if (this.owned.size >= LIMIT) throw new Error(PROCESS_TREE_LIMIT);
          this.owned.set(child.pid, child);
          queue.push(child);
        }
      }
    }
    if (deferred) throw deferred.error;
  }

  observe(): void { this.collect(false); }

  snapshot(): readonly OwnedProcess[] {
    this.collect(false);
    return [...this.owned.values()].map(({ pid, start }) => ({ pid, start }));
  }

  kill(): void {
    let failure: unknown;
    try { this.collect(true); } catch (error) { failure = error; }
    // Even on an inspection/limit failure, never leave an already frozen process alive.
    for (const identity of [...this.owned.values()].reverse()) {
      try { this.signal(identity, 'SIGKILL'); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
