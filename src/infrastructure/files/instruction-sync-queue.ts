import { RunnerError } from '../../domain/contracts.js';

type Release = () => void;
type Waiter = { grant(): void };

/** Bounded, process-local FIFO permits for short instruction reconciliations only. */
export class InstructionSyncQueue {
  private readonly queues = new Map<string, Waiter[]>();
  private size = 0;

  constructor(private readonly capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid queue capacity');
  }

  acquire(identity: string, signal: AbortSignal): Promise<Release> {
    signal.throwIfAborted();
    if (this.size >= this.capacity) throw new RunnerError('busy');
    this.size += 1;
    const existing = this.queues.get(identity);
    const queue = existing ?? [];
    if (!existing) this.queues.set(identity, queue);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        this.size -= 1;
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener('abort', abort);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.size -= 1;
            const next = queue.shift();
            if (next) { next.grant(); return; }
            this.queues.delete(identity);
          });
        },
      };
      if (existing) {
        queue.push(waiter);
        signal.addEventListener('abort', abort, { once: true });
        return;
      }
      waiter.grant();
    });
  }
}
