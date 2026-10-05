import { RunnerError } from '../domain/contracts.js';
import { validateAccountUsage, type AccountUsageProvider, type AccountUsageSnapshot } from '../domain/account-usage.js';

export interface AccountUsageReader {
  read(provider: AccountUsageProvider, signal: AbortSignal): Promise<AccountUsageSnapshot>;
}
export interface AccountUsageApplication {
  read(provider: AccountUsageProvider): Promise<AccountUsageSnapshot>;
  close(): Promise<void>;
}

/** Account-level reads are shared across every project and task on this runner. */
export class AccountUsageService implements AccountUsageApplication {
  private readonly pending = new Map<AccountUsageProvider, Promise<AccountUsageSnapshot>>();
  private readonly cancellation = new AbortController();
  constructor(private readonly reader: AccountUsageReader) {}
  read(provider: AccountUsageProvider): Promise<AccountUsageSnapshot> {
    if (this.cancellation.signal.aborted) return Promise.reject(new RunnerError('storage_unavailable'));
    const current = this.pending.get(provider);
    if (current) return current;
    // Closed providers and one pending read per provider bound concurrency to two.
    const pending = this.reader.read(provider, this.cancellation.signal).then(snapshot => {
      if (this.cancellation.signal.aborted || snapshot.provider !== provider) throw new RunnerError('storage_unavailable');
      return validateAccountUsage(snapshot);
    }).catch(() => { throw new RunnerError('storage_unavailable'); }).finally(() => {
      if (this.pending.get(provider) === pending) this.pending.delete(provider);
    });
    this.pending.set(provider, pending);
    return pending;
  }
  async close(): Promise<void> {
    this.cancellation.abort();
    await Promise.allSettled(this.pending.values());
  }
}
