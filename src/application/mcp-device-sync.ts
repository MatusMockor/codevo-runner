import { RunnerError } from '../domain/contracts.js';
import type { RegisteredProject } from '../domain/execution.js';
import {
  mcpDeviceSyncNames, planDeviceSync, preapprovedMcpServers, sameMcpDeviceSyncLedger, settleDeviceSync, storedDigest, type ClaudeStoredServers,
  type McpDeviceSyncItem, type McpDeviceSyncLedger, type McpDeviceSyncProgress, type McpDeviceSyncReport, type McpDeviceSyncRequest,
  type McpDeviceSyncStep,
} from '../domain/mcp-device-sync.js';
import type { McpServerPreapprovals } from './execution-ports.js';
import type { GitWorkspaces } from './git-sync-ports.js';
import { mcpServersCheckout, type McpServersWorkdir } from './mcp-servers-service.js';

export interface ClaudeLocalConfigReader {
  read(workdir: McpServersWorkdir, names: ReadonlySet<string>, signal: AbortSignal): Promise<ClaudeStoredServers>;
}
export interface McpDeviceSyncLedgerRepository {
  load(projectId: string, signal: AbortSignal): Promise<McpDeviceSyncLedger>;
  save(projectId: string, servers: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void>;
}
export interface McpDeviceSyncExecutor {
  available(command: string, workdir: McpServersWorkdir, signal: AbortSignal): Promise<boolean>;
  run(step: McpDeviceSyncStep, workdir: McpServersWorkdir, signal: AbortSignal): Promise<boolean>;
}
export type McpDeviceSyncPorts = Readonly<{
  config: ClaudeLocalConfigReader; ledgers: McpDeviceSyncLedgerRepository; executor: McpDeviceSyncExecutor;
}>;
export type McpDeviceSyncSignals = Readonly<{ work: AbortSignal; settle: AbortSignal }>;

const NO_NAMES: ReadonlySet<string> = new Set();

type Guard = 'same' | 'diverged' | 'unknown';

export class McpDeviceSyncIo {
  private pending = 0;
  private waiters: Array<() => void> = [];

  get idle(): boolean { return this.pending === 0; }

  within<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new RunnerError('storage_unavailable'));
    const started = work(signal);
    this.pending++;
    started.then(() => this.settle(), () => this.settle());
    return new Promise<T>((resolve, reject) => {
      const abandon = () => reject(new RunnerError('storage_unavailable'));
      signal.addEventListener('abort', abandon, { once: true });
      started.then(resolve, reject).finally(() => signal.removeEventListener('abort', abandon));
    });
  }

  drained(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise(resolve => { this.waiters.push(resolve); });
  }

  private settle(): void {
    this.pending--;
    if (!this.idle) return;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach(resolve => resolve());
  }
}

async function missingCommands(io: McpDeviceSyncIo, executor: McpDeviceSyncExecutor, request: McpDeviceSyncRequest, workdir: McpServersWorkdir,
  signal: AbortSignal): Promise<ReadonlySet<string>> {
  const missing = new Set<string>();
  try {
    for (const server of request.servers) {
      if (server.launch.kind !== 'stdio') continue;
      const command = server.launch.command;
      if (!await io.within(bounded => executor.available(command, workdir, bounded), signal)) missing.add(server.name);
    }
  } catch { return NO_NAMES; }
  return missing;
}

class DeviceSyncRun {
  constructor(private readonly io: McpDeviceSyncIo, private readonly ports: McpDeviceSyncPorts, private readonly workdir: McpServersWorkdir,
    private readonly signal: AbortSignal) {}

  async apply(item: McpDeviceSyncItem): Promise<McpDeviceSyncProgress | undefined> {
    for (const step of item.steps) {
      if (this.signal.aborted) return undefined;
      const guard: Guard = step.kind === 'remove' ? await this.guard(step.name, step.digest) : 'same';
      if (guard === 'diverged') return 'diverged';
      if (guard === 'unknown' || !await this.run(step)) return undefined;
    }
    return this.signal.aborted ? undefined : 'applied';
  }

  private async guard(name: string, digest: string): Promise<Guard> {
    try {
      const current = await this.io.within(bounded => this.ports.config.read(this.workdir, new Set([name]), bounded), this.signal);
      if (this.signal.aborted) return 'unknown';
      return storedDigest(current.get(name)) === digest ? 'same' : 'diverged';
    } catch { return 'unknown'; }
  }

  private run(step: McpDeviceSyncStep): Promise<boolean> {
    return this.io.within(bounded => this.ports.executor.run(step, this.workdir, bounded), this.signal).catch(() => false);
  }
}

export async function synchronizeDevice(ports: McpDeviceSyncPorts, projectId: string, workdir: McpServersWorkdir, request: McpDeviceSyncRequest,
  signals: McpDeviceSyncSignals, io: McpDeviceSyncIo): Promise<McpDeviceSyncReport> {
  const { work, settle } = signals;
  const ledger = await io.within(bounded => ports.ledgers.load(projectId, bounded), work);
  const names = mcpDeviceSyncNames(request, ledger);
  const current = await io.within(bounded => ports.config.read(workdir, names, bounded), work);
  const plan = planDeviceSync(request.servers, request.retain, current, ledger, await missingCommands(io, ports.executor, request, workdir, work));
  const run = new DeviceSyncRun(io, ports, workdir, work);
  const progress = new Map<string, McpDeviceSyncProgress>();
  for (const item of plan.items) {
    if (item.steps.length === 0) continue;
    const state = await run.apply(item);
    if (state) progress.set(item.name, state);
  }
  settle.throwIfAborted();
  const changed = plan.items.some(item => item.steps.length > 0);
  const final = changed ? await io.within(bounded => ports.config.read(workdir, names, bounded), settle) : current;
  const settlement = settleDeviceSync(plan, progress, final);
  if (!sameMcpDeviceSyncLedger(ledger, settlement.ledger)) await io.within(bounded => ports.ledgers.save(projectId, settlement.ledger, bounded), settle);
  return settlement.report;
}

export class McpDeviceSyncPreapprovals implements McpServerPreapprovals {
  constructor(
    private readonly workspaces: Pick<GitWorkspaces, 'checkout'>,
    private readonly ledgers: Pick<McpDeviceSyncLedgerRepository, 'load'>,
    private readonly config: ClaudeLocalConfigReader,
    private readonly checkoutMs = 5_000,
  ) {}

  async claudeServers(project: RegisteredProject, signal: AbortSignal): Promise<readonly string[]> {
    const ledger = await this.ledgers.load(project.id, signal);
    if (ledger.kind !== 'valid' || ledger.servers.size === 0) return [];
    signal.throwIfAborted();
    const workdir = await mcpServersCheckout(this.workspaces, project, signal, this.checkoutMs);
    signal.throwIfAborted();
    return preapprovedMcpServers(ledger, await this.config.read(workdir, new Set(ledger.servers.keys()), signal));
  }
}
