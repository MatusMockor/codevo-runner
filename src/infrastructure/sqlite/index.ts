import { Worker } from 'node:worker_threads';
import type { RunnerRepository } from '../../application/ports.js';
import { RunnerError, type Attachment, type CreateTask, type Page, type Task, type TaskEvent } from '../../domain/contracts.js';
import type { Operation, Reply } from './protocol.js';
type Pending = { resolve(value: unknown): void; reject(error: RunnerError): void; timer: NodeJS.Timeout };
class SqliteRepository implements RunnerRepository {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closePromise?: Promise<void>;
  readonly ready: Promise<void>;
  constructor(private readonly worker: Worker) {
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve: () => resolve(), reject, timer: this.deadline() }));
    worker.on('message', (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error) { pending.reject(new RunnerError(reply.error)); return; }
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
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer: this.deadline() });
      try { this.worker.postMessage({ ...operation, id }); }
      catch { clearTimeout(this.pending.get(id)!.timer); this.pending.delete(id); reject(new RunnerError('storage_unavailable')); }
    });
  }
  createTask(input: CreateTask): Promise<{ task: Task; created: boolean }> { return this.call({ method: 'createTask', args: [input] }); }
  getTask(id: string): Promise<Task> { return this.call({ method: 'getTask', args: [id] }); }
  listTasks(after: number): Promise<Page<Task>> { return this.call({ method: 'listTasks', args: [after] }); }
  cancelTask(id: string): Promise<Task> { return this.call({ method: 'cancelTask', args: [id] }); }
  listEvents(taskId: string, after: number): Promise<Page<TaskEvent>> { return this.call({ method: 'listEvents', args: [taskId, after] }); }
  putAttachment(value: Attachment): Promise<{ attachment: Attachment; created: boolean }> { return this.call({ method: 'putAttachment', args: [value] }); }
  getAttachment(id: string): Promise<Attachment> { return this.call({ method: 'getAttachment', args: [id] }); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return this.worker.terminate().then(() => undefined);
    this.closed = true;
    this.closePromise = this.call<void>({ method: 'close', args: [] }, true).finally(async () => { await this.worker.terminate(); });
    return this.closePromise;
  }
}
export async function openSqliteRepository(dataDir: string, runnerId: string): Promise<RunnerRepository> {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { dataDir, runnerId } });
  const repository = new SqliteRepository(worker);
  try { await repository.ready; return repository; }
  catch (error) { await worker.terminate(); throw error; }
}
