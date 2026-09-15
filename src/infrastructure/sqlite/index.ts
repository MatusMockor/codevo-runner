import type { HistorySearchRepository } from '../../application/history-search.js';
import type { HistorySearchQuery, HistorySearchPage } from '../../domain/history-search.js';
import type { ContinueTask, ResumeState } from '../../domain/task-resume.js';
import type { CloneRepository } from '../../application/clone-ports.js';
import type { CloneInput, CloneJob, StoredClone } from '../../domain/project-clone.js';
import type { RegisteredProject } from '../../domain/execution.js';
import type { ExecutionRepository } from '../../application/execution-ports.js';
import type { ExecutionResult, OutputChannel } from '../../domain/execution.js';
import { Worker } from 'node:worker_threads';
import type { RunnerRepository } from '../../application/ports.js';
import { RunnerError, type Attachment, type CreateTask, type Page, type Task, type TaskEvent } from '../../domain/contracts.js';
import type { Operation, Reply } from './protocol.js';
type Pending = { resolve(value: unknown): void; reject(error: RunnerError): void; timer: NodeJS.Timeout; operation?: Operation };
class SqliteRepository implements RunnerRepository, ExecutionRepository, CloneRepository, HistorySearchRepository {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closePromise?: Promise<void>;
  readonly ready: Promise<void>;
  constructor(private readonly worker: Worker, private readonly changed: () => void) {
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve: () => resolve(), reject, timer: this.deadline() }));
    worker.on('message', (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error) { pending.reject(new RunnerError(reply.error)); return; }
      if (pending.operation && changesInventory(pending.operation, reply.value)) {
        // Persistence already committed; notification failures must not strand callers.
        try { this.changed(); } catch { /* Notifications are best-effort invalidations. */ }
      }
      pending.resolve(reply.value);
    });
    worker.on('error', () => this.fail());
    worker.on('exit', () => this.fail());
  }
  private deadline(): NodeJS.Timeout {
    return setTimeout(() => { this.fail(); void this.worker.terminate(); }, 30_000).unref();
  }
  private fail(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RunnerError('storage_unavailable')); }
    this.pending.clear();
  }
  private call<T>(operation: Operation, closing = false): Promise<T> {
    if (this.closed && !closing) return Promise.reject(new RunnerError('storage_unavailable'));
    if (this.pending.size >= 64 && !closing) return Promise.reject(new RunnerError('busy'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer: this.deadline(), operation });
      try { this.worker.postMessage({ ...operation, id }); }
      catch { clearTimeout(this.pending.get(id)!.timer); this.pending.delete(id); reject(new RunnerError('storage_unavailable')); }
    });
  }
  searchHistory(query: HistorySearchQuery): Promise<HistorySearchPage> { return this.call({ method: 'searchHistory', args: [query] }); }
  getTaskSession(id: string): Promise<{ sessionId: string | null; workspaceTaskId: string }> { return this.call({ method: 'getTaskSession', args: [id] }); }
  getResumeState(id: string): Promise<ResumeState> { return this.call({ method: 'getResumeState', args: [id] }); }
  findContinuation(id: string, input: ContinueTask): Promise<{ task: Task; created: false } | null> { return this.call({ method: 'findContinuation', args: [id, input] }); }
  continueTask(id: string, input: ContinueTask): Promise<{ task: Task; created: boolean }> { return this.call({ method: 'continueTask', args: [id, input] }); }
  setTaskSession(id: string, sessionId: string): Promise<void> { return this.call({ method: 'setTaskSession', args: [id, sessionId] }); }
  createTask(input: CreateTask): Promise<{ task: Task; created: boolean }> { return this.call({ method: 'createTask', args: [input] }); }
  getTask(id: string): Promise<Task> { return this.call({ method: 'getTask', args: [id] }); }
  listTasks(after: number): Promise<Page<Task>> { return this.call({ method: 'listTasks', args: [after] }); }
  cancelTask(id: string): Promise<Task> { return this.call({ method: 'cancelTask', args: [id] }); }
  listEvents(taskId: string, after: number): Promise<Page<TaskEvent>> { return this.call({ method: 'listEvents', args: [taskId, after] }); }
  putAttachment(value: Attachment): Promise<{ attachment: Attachment; created: boolean }> { return this.call({ method: 'putAttachment', args: [value] }); }
  getAttachment(id: string): Promise<Attachment> { return this.call({ method: 'getAttachment', args: [id] }); }
  queueTask(id: string, projectId: string): Promise<Task> { return this.call({ method: 'queueTask', args: [id, projectId] }); }
  claimNextTask(): Promise<Task | null> { return this.call({ method: 'claimNextTask', args: [] }); }
  appendTaskOutput(id: string, channel: OutputChannel, text: string): Promise<void> { return this.call({ method: 'appendTaskOutput', args: [id, channel, text] }); }
  finishTask(id: string, result: ExecutionResult): Promise<Task> { return this.call({ method: 'finishTask', args: [id, result] }); }
  interruptRunningTasks(): Promise<void> { return this.call({ method: 'interruptRunningTasks', args: [] }); }
  createClone(input: CloneInput, maximumProjects = 32): Promise<CloneJob> { return this.call({ method: 'createClone', args: [input, maximumProjects] }); }
  getClone(id: string): Promise<CloneJob> { return this.call({ method: 'getClone', args: [id] }); }
  cancelClone(id: string): Promise<CloneJob> { return this.call({ method: 'cancelClone', args: [id] }); }
  claimClone(): Promise<StoredClone | null> { return this.call({ method: 'claimClone', args: [] }); }
  finishClone(id: string, status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled', project: RegisteredProject | null, error: string | null): Promise<CloneJob> { return this.call({ method: 'finishClone', args: [id, status, project, error] }); }
  interruptClones(): Promise<void> { return this.call({ method: 'interruptClones', args: [] }); }
  listManagedProjects(): Promise<readonly RegisteredProject[]> { return this.call({ method: 'listManagedProjects', args: [] }); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return this.worker.terminate().then(() => undefined);
    this.closed = true;
    this.closePromise = this.call<void>({ method: 'close', args: [] }, true).finally(async () => { await this.worker.terminate(); });
    return this.closePromise;
  }
}
export async function openSqliteRepository(dataDir: string, runnerId: string, changed: () => void = () => {}): Promise<RunnerRepository & ExecutionRepository & CloneRepository & HistorySearchRepository> {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { dataDir, runnerId } });
  const repository = new SqliteRepository(worker, changed);
  try { await repository.ready; return repository; }
  catch (error) { await worker.terminate(); throw error; }
}

function changesInventory(operation: Operation, value: unknown): boolean {
  switch (operation.method) {
    case 'createClone': case 'cancelClone': case 'finishClone': case 'interruptClones':
    case 'continueTask': case 'setTaskSession': case 'createTask': case 'cancelTask':
    case 'queueTask': case 'appendTaskOutput': case 'finishTask': case 'interruptRunningTasks':
      return true;
    case 'claimClone': case 'claimNextTask': return value !== null;
    case 'listManagedProjects': case 'getClone': case 'getTaskSession': case 'getResumeState':
    case 'findContinuation': case 'getTask': case 'listTasks': case 'listEvents':
    case 'putAttachment': case 'getAttachment': case 'close': case 'searchHistory': return false;
  }
}
