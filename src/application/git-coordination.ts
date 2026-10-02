import { RunnerError } from '../domain/contracts.js';
import { GIT_SYNC_LIMITS } from '../domain/git-sync.js';

type Release = () => void;

class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly capacity: number) {}

  get idle(): boolean { return this.active === 0 && this.waiters.length === 0; }

  acquire(signal?: AbortSignal): Promise<Release> {
    signal?.throwIfAborted();
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel);
        this.active++;
        resolve(this.releaser());
      };
      const cancel = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason);
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

class KeyedGate {
  private readonly gates = new Map<string, Gate>();

  async run<T>(key: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    let gate = this.gates.get(key);
    if (!gate) { gate = new Gate(1); this.gates.set(key, gate); }
    const owned = gate;
    let release: Release | undefined;
    try {
      release = await owned.acquire(signal);
      return await action();
    } finally {
      release?.();
      if (owned.idle && this.gates.get(key) === owned) this.gates.delete(key);
    }
  }
}

export type GitLeaseMode = 'worktree' | 'in-place';
export type FetchOutcome = Readonly<{ fetchedAt: string; coalesced: boolean }>;
export type GitCoordinationOptions = Readonly<{ networkOperations?: number; fetchCoalesceMs?: number; leaseWaitMs?: number; now?: () => number }>;

export function gitLeaseKey(mode: GitLeaseMode, projectId: string, workspaceTaskId: string): string {
  return mode === 'in-place' ? `project:${projectId}` : `task:${workspaceTaskId}`;
}

/** Shared by turn admission and Git sync: lease order is always workspace, then project, then network. */
export class GitCoordination {
  private readonly projects = new KeyedGate();
  private readonly workspaces = new KeyedGate();
  private readonly network: Gate;
  private readonly fetches = new Map<string, number>();
  private readonly fetchCoalesceMs: number;
  private readonly leaseWaitMs: number;
  private readonly now: () => number;

  constructor(options: GitCoordinationOptions = {}) {
    this.network = new Gate(options.networkOperations ?? GIT_SYNC_LIMITS.networkOperations);
    this.fetchCoalesceMs = options.fetchCoalesceMs ?? GIT_SYNC_LIMITS.fetchCoalesceMs;
    this.leaseWaitMs = options.leaseWaitMs ?? GIT_SYNC_LIMITS.leaseWaitMs;
    this.now = options.now ?? Date.now;
  }

  fetchedAt(projectId: string): string | null {
    const time = this.fetches.get(projectId);
    return time === undefined ? null : new Date(time).toISOString();
  }

  withProject<T>(projectId: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    return this.projects.run(projectId, signal, action);
  }

  async withNetwork<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const release = await this.network.acquire(signal);
    try { return await action(); }
    finally { release(); }
  }

  async fetchHeld(projectId: string, signal: AbortSignal | undefined, fetch: (signal?: AbortSignal) => Promise<void>, coalesce = true): Promise<FetchOutcome> {
    const previous = this.fetches.get(projectId);
    if (coalesce && previous !== undefined && this.now() - previous < this.fetchCoalesceMs)
      return { fetchedAt: new Date(previous).toISOString(), coalesced: true };
    await this.withNetwork(signal, () => fetch(signal));
    const completed = this.now();
    this.fetches.set(projectId, completed);
    return { fetchedAt: new Date(completed).toISOString(), coalesced: false };
  }

  fetch(projectId: string, signal: AbortSignal | undefined, fetch: (signal?: AbortSignal) => Promise<void>): Promise<FetchOutcome> {
    return this.withProject(projectId, signal, () => this.fetchHeld(projectId, signal, fetch));
  }

  withWorkspace<T>(key: string, signal: AbortSignal | undefined, action: () => Promise<T>, waitMs: number = this.leaseWaitMs): Promise<T> {
    const wait = AbortSignal.timeout(waitMs);
    const admission = signal ? AbortSignal.any([signal, wait]) : wait;
    let admitted = false;
    return this.workspaces.run(key, admission, () => {
      admitted = true;
      return action();
    }).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (!admitted && wait.aborted) throw new RunnerError('busy');
      throw error;
    });
  }

  awaitWorkspace(key: string, signal?: AbortSignal): Promise<void> {
    return this.withWorkspace(key, signal, async () => undefined);
  }
}
