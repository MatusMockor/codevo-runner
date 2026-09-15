import { randomUUID } from 'node:crypto';
import { RunnerError } from '../domain/contracts.js';

export type RunnerChange = Readonly<{ epoch: string; revision: number }>;
export interface RunnerChangeSource {
  snapshot(): RunnerChange;
  subscribe(listener: () => void): () => void;
}
/** Invalidation only: clients reload authoritative HTTP snapshots after reconnect. */
export class RunnerChanges implements RunnerChangeSource {
  private epoch = randomUUID();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  snapshot(): RunnerChange { return { epoch: this.epoch, revision: this.revision }; }
  publish(): void {
    if (this.revision === Number.MAX_SAFE_INTEGER) { this.epoch = randomUUID(); this.revision = 0; }
    else this.revision++;
    for (const listener of this.listeners) {
      // Observers cannot roll back a durable mutation or suppress other observers.
      try { listener(); } catch { /* The next snapshot repairs failed delivery. */ }
    }
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 16) throw new RunnerError('busy');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
