import type { Attachment, CreateTask, Page, Task, TaskEvent } from '../domain/contracts.js';

/** Implementations own transactions, uniqueness, quotas and runner scoping. */
export interface TaskRepository {
  createTask(input: CreateTask): Promise<Readonly<{ task: Task; created: boolean }>>;
  getTask(id: string): Promise<Task>;
  listTasks(after: number): Promise<Page<Task>>;
  cancelTask(id: string): Promise<Task>;
  listEvents(taskId: string, after: number): Promise<Page<TaskEvent>>;
}
export interface AttachmentRepository {
  putAttachment(value: Attachment): Promise<Readonly<{ attachment: Attachment; created: boolean }>>;
  getAttachment(id: string): Promise<Attachment>;
}
export interface RunnerRepository extends TaskRepository, AttachmentRepository {
  close(): Promise<void>;
}
/** Files are immutable; implementations validate bytes and own storage paths. */
export interface AttachmentStore {
  metadata(id: string): Promise<Attachment>;
  upload(id: string, name: string, mediaType: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Readonly<{ attachment: Attachment; created: boolean }>>;
  read(id: string): Promise<Readonly<{ attachment: Attachment; bytes: Uint8Array }>>;
  close(): Promise<void>;
}

/** UI/HTTP adapters consume application use cases rather than concrete services. */
export interface TaskApplication {
  create(input: unknown): Promise<Readonly<{ task: Task; created: boolean }>>;
  get(id: string): Promise<Task>;
  list(after: number): Promise<Page<Task>>;
  cancel(id: string): Promise<Task>;
  events(id: string, after: number): Promise<Page<TaskEvent>>;
}
