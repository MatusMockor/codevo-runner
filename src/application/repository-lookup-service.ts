import { parseRepositoryRequest, type RepositoryProvider, type RepositoryHostsState, type RepositoryHostsSnapshot, type RepositoryLookupRequest, type RepositoryLookupOutcome, type RepositorySearchRequest, type RepositorySearchOutcome, type RepositoryFailure } from '../domain/repository-lookup.js';
export interface RepositoryLookupPort {
  hosts(provider: RepositoryProvider, signal: AbortSignal): Promise<RepositoryHostsState>;
  lookup(request: RepositoryLookupRequest, signal: AbortSignal): Promise<RepositoryLookupOutcome>;
  search(request: RepositorySearchRequest, signal: AbortSignal): Promise<RepositorySearchOutcome>;
}
export class RepositoryLookupService {
  private active = 0;
  constructor(private readonly port: RepositoryLookupPort) {}
  async hosts(signal: AbortSignal = new AbortController().signal): Promise<RepositoryHostsSnapshot> {
    if (this.active >= 2) return { github: { status: 'failed', reason: 'busy' }, gitlab: { status: 'failed', reason: 'busy' } };
    this.active++;
    try {
      const github = await this.port.hosts('github', signal);
      signal.throwIfAborted();
      const gitlab = await this.port.hosts('gitlab', signal);
      signal.throwIfAborted();
      return { github, gitlab };
    } finally { this.active--; }
  }
  async lookup(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<RepositoryLookupOutcome> {
    const request = parseRepositoryRequest(input, false);
    return this.perform(request, signal, () => this.port.lookup(request, signal));
  }
  async search(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<RepositorySearchOutcome> {
    const request = parseRepositoryRequest(input, true);
    return this.perform(request, signal, () => this.port.search(request, signal));
  }
  private async perform<T extends RepositoryLookupOutcome | RepositorySearchOutcome>(request: RepositoryLookupRequest | RepositorySearchRequest, signal: AbortSignal, execute: () => Promise<T>): Promise<T | RepositoryFailure> {
    if (this.active >= 2) return { status: 'failed', reason: 'busy' };
    this.active++;
    try {
      signal.throwIfAborted();
      const hosts = await this.port.hosts(request.provider, signal);
      signal.throwIfAborted();
      if (hosts.status === 'cliMissing') return hosts;
      if (hosts.status === 'failed') return hosts.reason === 'timedOut' ? { status: 'timedOut' } : { status: 'failed', reason: hosts.reason };
      const host = hosts.hosts.find(item => item.host === request.host);
      if (!host) return { status: 'hostNotAllowed' };
      if (host.auth !== 'authenticated') return { status: 'notAuthenticated' };
      const result = await execute();
      signal.throwIfAborted();
      return result;
    } finally { this.active--; }
  }
}
