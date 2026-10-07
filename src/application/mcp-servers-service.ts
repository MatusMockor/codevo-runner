import { RunnerError } from '../domain/contracts.js';
import type { RegisteredProject } from '../domain/execution.js';
import { validProjectId } from '../domain/git-sync.js';
import { validateMcpServers, type McpServers, type McpServersProvider } from '../domain/mcp-servers.js';
import type { ProjectRegistry } from './execution-ports.js';
import type { GitWorkdir, GitWorkspaces } from './git-sync-ports.js';

export type McpServersWorkdir = GitWorkdir;
export interface McpServersReader {
  read(provider: McpServersProvider, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServers>;
}
export interface McpServersApplication {
  read(projectId: string, provider: McpServersProvider, disconnected: AbortSignal): Promise<McpServers>;
  close(): Promise<void>;
}

export type McpServersPolicy = Readonly<{ concurrentProbes: number; checkoutMs: number }>;
export const MCP_SERVERS_POLICY: McpServersPolicy = Object.freeze({ concurrentProbes: 2, checkoutMs: 5_000 });
export type McpServersOptions = Readonly<{ policy?: Partial<McpServersPolicy> }>;

export class McpServersService implements McpServersApplication {
  private readonly probes = new Set<Promise<McpServers>>();
  private readonly cancellation = new AbortController();
  private readonly policy: McpServersPolicy;

  constructor(
    private readonly projects: Pick<ProjectRegistry, 'get'>,
    private readonly workspaces: Pick<GitWorkspaces, 'checkout'>,
    private readonly reader: McpServersReader,
    options: McpServersOptions = {},
  ) {
    this.policy = { ...MCP_SERVERS_POLICY, ...options.policy };
  }

  async read(projectId: string, provider: McpServersProvider, disconnected: AbortSignal): Promise<McpServers> {
    this.assertOpen(disconnected);
    const project = await this.project(projectId);
    this.assertOpen(disconnected);
    if (this.probes.size >= this.policy.concurrentProbes) throw new RunnerError('busy');
    const probe = this.probe(project, provider, AbortSignal.any([this.cancellation.signal, disconnected]));
    this.probes.add(probe);
    try { return await probe; }
    catch { throw new RunnerError('storage_unavailable'); }
    finally { this.probes.delete(probe); }
  }

  async close(): Promise<void> {
    this.cancellation.abort();
    await Promise.allSettled(this.probes);
  }

  private assertOpen(disconnected: AbortSignal): void {
    if (this.cancellation.signal.aborted || disconnected.aborted) throw new RunnerError('storage_unavailable');
  }

  private async project(projectId: string): Promise<RegisteredProject> {
    if (!validProjectId(projectId)) throw new RunnerError('not_found');
    try { return await this.projects.get(projectId); }
    catch (error) {
      if (error instanceof RunnerError && error.code === 'not_found') throw error;
      throw new RunnerError('storage_unavailable');
    }
  }

  private async checkout(project: RegisteredProject, signal: AbortSignal): Promise<McpServersWorkdir> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.policy.checkoutMs);
    const bounded = AbortSignal.any([signal, deadline.signal]);
    try {
      const workdir = await new Promise<McpServersWorkdir>((resolve, reject) => {
        const abandon = () => reject(new RunnerError('storage_unavailable'));
        if (bounded.aborted) return abandon();
        bounded.addEventListener('abort', abandon, { once: true });
        this.workspaces.checkout(project, bounded).then(resolve, reject);
      });
      bounded.throwIfAborted();
      return workdir;
    } finally { clearTimeout(timer); }
  }

  private async probe(project: RegisteredProject, provider: McpServersProvider, signal: AbortSignal): Promise<McpServers> {
    const workdir = await this.checkout(project, signal);
    signal.throwIfAborted();
    const snapshot = validateMcpServers(await this.reader.read(provider, workdir, signal));
    if (signal.aborted || snapshot.provider !== provider) throw new RunnerError('storage_unavailable');
    return snapshot;
  }
}
