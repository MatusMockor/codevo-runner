import { RunnerError } from '../domain/contracts.js';
import { validProjectId } from '../domain/git-sync.js';
import { portList, type PortList, type PortSource } from '../domain/port-preview.js';
import type { OwnedProcessTree } from '../domain/process-ownership.js';
import { validateId } from '../domain/task-input.js';
import type { Task } from '../domain/contracts.js';
import type { ProjectRegistry } from './execution-ports.js';
import type { ListeningPortScanner, PortOwner, PortPreviewApplication } from './port-preview-ports.js';
import type { OwnedTrees } from './process-ownership.js';
import type { TerminalProcessOwner } from './terminal-service.js';

export type PortScanLimits = Readonly<{ deadlineMs: number; cacheMs: number; concurrentScans: number; cachedScopes: number }>;
export const PORT_SCAN_LIMITS: PortScanLimits = Object.freeze({ deadlineMs: 2000, cacheMs: 1000, concurrentScans: 4, cachedScopes: 64 });

export interface PortPreviewTasks {
  getTask(id: string): Promise<Task>;
  getTaskSession(id: string): Promise<Readonly<{ workspaceTaskId: string }>>;
}
export interface AgentProcessQuery {
  conversation(conversationId: string): OwnedTrees;
  inPlaceProject(projectId: string): OwnedTrees;
}
export interface TerminalProcessQuery {
  processOwners(projectId: string): Promise<readonly TerminalProcessOwner[]>;
}
export type PortPreviewOptions = Readonly<{
  excludedPorts?: readonly number[];
  clock?: () => number;
  limits?: Partial<PortScanLimits>;
}>;

const SETTLE_GRACE_MS = 500;
type OwnerSource = Readonly<{ source: PortSource; trees: readonly OwnedProcessTree[]; complete: boolean }>;
type CacheEntry = { at: number; settled: boolean; readonly result: Promise<PortList> };

export class PortPreviewService implements PortPreviewApplication {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly excludedPorts: ReadonlySet<number>;
  private readonly clock: () => number;
  private readonly limits: PortScanLimits;
  private scans = 0;

  constructor(
    private readonly tasks: PortPreviewTasks,
    private readonly projects: Pick<ProjectRegistry, 'get'>,
    private readonly agents: AgentProcessQuery,
    private readonly terminals: TerminalProcessQuery,
    private readonly scanner: ListeningPortScanner,
    options: PortPreviewOptions = {},
  ) {
    this.excludedPorts = new Set(options.excludedPorts ?? []);
    this.clock = options.clock ?? Date.now;
    this.limits = { ...PORT_SCAN_LIMITS, ...options.limits };
  }

  async taskPorts(taskId: string): Promise<PortList> {
    const task = await this.tasks.getTask(validateId(taskId));
    const { workspaceTaskId } = await this.tasks.getTaskSession(taskId);
    return this.cached(`task:${workspaceTaskId}`, async () => [
      { source: 'agent', ...this.agents.conversation(workspaceTaskId) },
      ...(task.projectId ? [await this.conversationTerminals(task.projectId, workspaceTaskId)] : []),
    ]);
  }

  async projectPorts(projectId: string): Promise<PortList> {
    if (!validProjectId(projectId)) throw new RunnerError('invalid_input');
    await this.projects.get(projectId);
    return this.cached(`project:${projectId}`, async () => [
      { source: 'agent', ...this.agents.inPlaceProject(projectId) },
      { source: 'terminal', trees: (await this.terminals.processOwners(projectId)).filter(owner => owner.taskId === null).map(owner => owner.tree), complete: true },
    ]);
  }

  private async conversationTerminals(projectId: string, workspaceTaskId: string): Promise<OwnerSource> {
    const trees: OwnedProcessTree[] = [];
    for (const owner of await this.terminals.processOwners(projectId)) {
      if (owner.taskId === null) continue;
      const session = await this.tasks.getTaskSession(owner.taskId).catch(() => undefined);
      if (session?.workspaceTaskId === workspaceTaskId) trees.push(owner.tree);
    }
    return { source: 'terminal', trees, complete: true };
  }

  private cached(key: string, sources: () => Promise<readonly OwnerSource[]>): Promise<PortList> {
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit && (!hit.settled || now - hit.at < this.limits.cacheMs)) return hit.result;
    if (this.scans >= this.limits.concurrentScans) throw new RunnerError('busy');
    this.scans++;
    const entry: CacheEntry = { at: now, settled: false, result: this.scan(sources) };
    entry.result.then(() => {
      entry.settled = true;
      entry.at = this.clock();
    }, () => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    }).finally(() => { this.scans--; });
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.evict();
    return entry.result;
  }

  private scan(sources: () => Promise<readonly OwnerSource[]>): Promise<PortList> {
    const deadline = AbortSignal.timeout(this.limits.deadlineMs);
    return new Promise<PortList>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RunnerError('busy')), this.limits.deadlineMs + SETTLE_GRACE_MS);
      timer.unref();
      this.collect(sources, deadline).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private async collect(sources: () => Promise<readonly OwnerSource[]>, deadline: AbortSignal): Promise<PortList> {
    const resolved = await sources();
    const owners: PortOwner[] = resolved.flatMap(source => source.trees.map(tree => snapshotOwner(source.source, tree)));
    const incomplete = resolved.some(source => !source.complete) || owners.some(owner => !owner.complete);
    const result = await this.scanner.scan(owners, deadline);
    return portList(result.ports, { excludedPorts: this.excludedPorts, truncated: result.truncated || incomplete, scannedAt: new Date(this.clock()).toISOString() });
  }

  private evict(): void {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.limits.cachedScopes) return;
      if (entry.settled) this.cache.delete(key);
    }
  }
}

function snapshotOwner(source: PortSource, tree: OwnedProcessTree): PortOwner {
  try { return { source, processes: tree.snapshot(), complete: true }; }
  catch { return { source, processes: [], complete: false }; }
}
