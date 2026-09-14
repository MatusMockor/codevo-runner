import { readFileSync, readdirSync } from 'node:fs';

interface Identity { readonly pid: number; readonly start: string; readonly parent: number }
const LIMIT = 4096;

/** Linux ownership uses kernel start times, never a recycled PID alone. */
export class LinuxProcessTree {
  private readonly owned = new Map<number, Identity>();
  constructor(root: number) {
    const identity = this.identity(root);
    if (identity) this.owned.set(root, identity);
  }

  private identity(pid: number): Identity | undefined {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm can contain spaces and parentheses; fields following its final ')' are fixed.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      return start && /^\d+$/.test(start) ? { pid, start, parent: Number(fields[1]) } : undefined;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
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
    for (const [pid, identity] of this.owned) {
      if (!this.current(identity)) this.owned.delete(pid);
    }
    const queue = [...this.owned.values()];
    const visited = new Set<number>();
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      if (visited.has(parent.pid) || !this.current(parent)) continue;
      visited.add(parent.pid);
      if (freeze) this.signal(parent, 'SIGSTOP');
      let threads: string[];
      try { threads = readdirSync(`/proc/${parent.pid}/task`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (threads.length > LIMIT) throw new Error('process_tree_limit');
      for (const thread of threads) {
        let children: string;
        try { children = readFileSync(`/proc/${parent.pid}/task/${thread}/children`, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (children.length > LIMIT * 16) throw new Error('process_tree_limit');
        for (const raw of children.trim().split(/\s+/)) {
          if (!/^\d+$/.test(raw)) continue;
          const child = this.identity(Number(raw));
          if (!child || child.parent !== parent.pid || !this.current(parent) || this.owned.get(child.pid)?.start === child.start) continue;
          if (this.owned.size >= LIMIT) throw new Error('process_tree_limit');
          this.owned.set(child.pid, child);
          queue.push(child);
        }
      }
    }
  }

  observe(): void { this.collect(false); }

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
