import { RunnerError } from '../domain/contracts.js';
import { validateCommandCatalog, type CommandCatalog, type CommandCatalogProvider } from '../domain/command-catalog.js';
import type { RegisteredProject } from '../domain/execution.js';
import { validProjectId } from '../domain/git-sync.js';
import type { ProjectRegistry } from './execution-ports.js';
import type { GitWorkdir, GitWorkspaces } from './git-sync-ports.js';

export type CommandCatalogWorkdir = GitWorkdir;
export interface CommandCatalogReader {
  read(provider: CommandCatalogProvider, workdir: CommandCatalogWorkdir, signal: AbortSignal): Promise<CommandCatalog>;
}
export interface CommandCatalogApplication {
  read(projectId: string, provider: CommandCatalogProvider): Promise<CommandCatalog>;
  close(): Promise<void>;
}

export type CommandCatalogPolicy = Readonly<{ freshMs: number; staleMs: number; cachedKeys: number; concurrentProbes: number; checkoutMs: number }>;
export const COMMAND_CATALOG_POLICY: CommandCatalogPolicy = Object.freeze({ freshMs: 60_000, staleMs: 600_000, cachedKeys: 32, concurrentProbes: 2, checkoutMs: 5_000 });
export type CommandCatalogOptions = Readonly<{ clock?: () => number; policy?: Partial<CommandCatalogPolicy> }>;

type Cached = Readonly<{ at: number; catalog: CommandCatalog }>;

/** Catalogs are owned by one registered checkout and provider; nothing is shared across keys. */
export class CommandCatalogService implements CommandCatalogApplication {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<CommandCatalog>>();
  private readonly cancellation = new AbortController();
  private readonly clock: () => number;
  private readonly policy: CommandCatalogPolicy;

  constructor(
    private readonly projects: Pick<ProjectRegistry, 'get'>,
    private readonly workspaces: Pick<GitWorkspaces, 'checkout'>,
    private readonly reader: CommandCatalogReader,
    options: CommandCatalogOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.policy = { ...COMMAND_CATALOG_POLICY, ...options.policy };
  }

  async read(projectId: string, provider: CommandCatalogProvider): Promise<CommandCatalog> {
    this.assertOpen();
    const project = await this.project(projectId);
    this.assertOpen();
    const key = JSON.stringify([provider, project.id, project.path]);
    const known = this.lastGood(key);
    if (known && this.clock() - known.at < this.policy.freshMs) return known.catalog;
    const current = this.pending.get(key);
    if (current) return current;
    // One pending probe per key; a refused admission serves the last good catalog or fails fast.
    if (this.pending.size >= this.policy.concurrentProbes) {
      if (known) return known.catalog;
      throw new RunnerError('busy');
    }
    const pending = this.probe(project, provider).then(catalog => this.store(key, catalog), () => this.fallback(key)).finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    });
    this.pending.set(key, pending);
    return pending;
  }

  async close(): Promise<void> {
    this.cancellation.abort();
    await Promise.allSettled(this.pending.values());
    this.cache.clear();
  }

  private assertOpen(): void {
    if (this.cancellation.signal.aborted) throw new RunnerError('storage_unavailable');
  }

  private async project(projectId: string): Promise<RegisteredProject> {
    if (!validProjectId(projectId)) throw new RunnerError('not_found');
    try { return await this.projects.get(projectId); }
    catch (error) {
      if (error instanceof RunnerError && error.code === 'not_found') throw error;
      throw new RunnerError('storage_unavailable');
    }
  }

  /** The deadline is enforced here, not by the workspace: a checkout that ignores its signal is abandoned. */
  private async checkout(project: RegisteredProject): Promise<CommandCatalogWorkdir> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.policy.checkoutMs);
    const signal = AbortSignal.any([this.cancellation.signal, deadline.signal]);
    try {
      const workdir = await new Promise<CommandCatalogWorkdir>((resolve, reject) => {
        const abandon = () => reject(new RunnerError('storage_unavailable'));
        if (signal.aborted) return abandon();
        signal.addEventListener('abort', abandon, { once: true });
        this.workspaces.checkout(project, signal).then(resolve, reject);
      });
      signal.throwIfAborted();
      return workdir;
    } finally { clearTimeout(timer); }
  }

  private async probe(project: RegisteredProject, provider: CommandCatalogProvider): Promise<CommandCatalog> {
    const signal = this.cancellation.signal;
    const workdir = await this.checkout(project);
    signal.throwIfAborted();
    const catalog = validateCommandCatalog(await this.reader.read(provider, workdir, signal));
    if (signal.aborted || catalog.provider !== provider) throw new RunnerError('storage_unavailable');
    return catalog;
  }

  private lastGood(key: string): Cached | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    if (this.clock() - cached.at < this.policy.staleMs) return cached;
    this.cache.delete(key);
    return undefined;
  }

  private store(key: string, catalog: CommandCatalog): CommandCatalog {
    this.cache.delete(key);
    this.cache.set(key, { at: this.clock(), catalog });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.policy.cachedKeys) break;
      this.cache.delete(oldest);
    }
    return catalog;
  }

  private fallback(key: string): CommandCatalog {
    const known = this.cancellation.signal.aborted ? undefined : this.lastGood(key);
    if (!known) throw new RunnerError('storage_unavailable');
    return known.catalog;
  }
}
