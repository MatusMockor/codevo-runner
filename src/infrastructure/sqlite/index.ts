import type { ThreadMetadataRepository } from '../../application/thread-metadata.js';
import type { ThreadMetadata, ThreadMetadataPage, ThreadMetadataPatch, ThreadOrder } from '../../domain/thread-metadata.js';
import type { AgentSubagentLifecycle } from '../../domain/subagent-lifecycle.js';
import type { SteerInput, SteerClaim, SteerReceipt } from '../../domain/steering.js';
import type { QuestionRepository } from '../../application/question-ports.js';
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../domain/questions.js';
import type { Artifact } from '../../domain/artifact.js';
import type { ArtifactRepository } from '../../application/artifact-ports.js';
import type { PendingMessage, PendingMessages } from '../../domain/pending-message.js';
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
import { RunnerError, type Attachment, type CreateTask, type EventPage, type Page, type Task, type TaskEvent } from '../../domain/contracts.js';
import type { Operation, Reply } from './protocol.js';
type Pending = { resolve(value: unknown): void; reject(error: RunnerError): void; timer: NodeJS.Timeout; operation?: Operation };
class SqliteRepository implements ThreadMetadataRepository, RunnerRepository, ExecutionRepository, CloneRepository, HistorySearchRepository, ArtifactRepository, QuestionRepository {
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
  reorderThread(id: string, input: ThreadOrder): Promise<{ items: readonly ThreadMetadata[] }> { return this.call({ method: 'reorderThread', args: [id, input] }); }
  getThreadMetadata(id: string): Promise<ThreadMetadata> { return this.call({ method: 'getThreadMetadata', args: [id] }); }
  listThreadMetadata(after: string): Promise<ThreadMetadataPage> { return this.call({ method: 'listThreadMetadata', args: [after] }); }
  patchThreadMetadata(id: string, patch: ThreadMetadataPatch): Promise<ThreadMetadata> { return this.call({ method: 'patchThreadMetadata', args: [id, patch] }); }
  claimSteer(id: string, input: SteerInput): Promise<SteerClaim> { return this.call({ method: 'claimSteer', args: [id, input] }); }
  findSteer(id: string, input: SteerInput): Promise<SteerReceipt | null> { return this.call({ method: 'findSteer', args: [id, input] }); }
  findPendingSteer(id: string, pendingId: string): Promise<SteerReceipt | null> { return this.call({ method: 'findPendingSteer', args: [id, pendingId] }); }
  claimPendingSteer(id: string, pendingId?: string): Promise<SteerClaim | null> { return this.call({ method: 'claimPendingSteer', args: pendingId === undefined ? [id] : [id, pendingId] }); }
  releaseSteer(id: string, messageId: string): Promise<void> { return this.call({ method: 'releaseSteer', args: [id, messageId] }); }
  acceptSteer(id: string, messageId: string): Promise<SteerReceipt> { return this.call({ method: 'acceptSteer', args: [id, messageId] }); }
  setTaskSubagents(taskId: string, snapshot: AgentSubagentLifecycle): Promise<void> { return this.call({ method: 'setTaskSubagents', args: [taskId, snapshot] }); }
  createQuestion(request: AgentQuestionRequest): Promise<AgentQuestionRequest> { return this.call({ method: 'createQuestion', args: [request] }); }
  listQuestions(taskId: string): Promise<readonly AgentQuestionRequest[]> { return this.call({ method: 'listQuestions', args: [taskId] }); }
  answerQuestion(taskId: string, id: string, response: AgentQuestionResponse): Promise<AgentQuestionRequest> { return this.call({ method: 'answerQuestion', args: [taskId, id, response] }); }
  expireQuestions(taskId?: string): Promise<void> { return this.call({ method: 'expireQuestions', args: taskId === undefined ? [] : [taskId] }); }
  listArtifactIds(): Promise<readonly string[]> { return this.call({ method: 'listArtifactIds', args: [] }); }
  putArtifact(artifact: Artifact, path: string): Promise<{ artifact: Artifact; created: boolean }> { return this.call({ method: 'putArtifact', args: [artifact, path] }); }
  findArtifact(taskId: string, path: string): Promise<Artifact | null> { return this.call({ method: 'findArtifact', args: [taskId, path] }); }
  getArtifact(taskId: string, id: string): Promise<Artifact> { return this.call({ method: 'getArtifact', args: [taskId, id] }); }
  listArtifacts(taskId: string): Promise<readonly Artifact[]> { return this.call({ method: 'listArtifacts', args: [taskId] }); }
  enqueuePending(id: string, input: ContinueTask): Promise<{ pending: PendingMessage; created: boolean }> { return this.call({ method: 'enqueuePending', args: [id, input] }); }
  listPending(id: string): Promise<PendingMessages> { return this.call({ method: 'listPending', args: [id] }); }
  removePending(id: string, pendingId: string): Promise<PendingMessage> { return this.call({ method: 'removePending', args: [id, pendingId] }); }
  resumePending(id: string): Promise<PendingMessages> { return this.call({ method: 'resumePending', args: [id] }); }
  promotePending(): Promise<Task | null> { return this.call({ method: 'promotePending', args: [] }); }
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
  listEvents(taskId: string, after: number): Promise<EventPage> { return this.call({ method: 'listEvents', args: [taskId, after] }); }
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
export async function openSqliteRepository(dataDir: string, runnerId: string, changed: () => void = () => {}): Promise<ThreadMetadataRepository & RunnerRepository & ExecutionRepository & CloneRepository & HistorySearchRepository & ArtifactRepository & QuestionRepository> {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { dataDir, runnerId } });
  const repository = new SqliteRepository(worker, changed);
  try { await repository.ready; return repository; }
  catch (error) { await worker.terminate(); throw error; }
}

function changesInventory(operation: Operation, value: unknown): boolean {
  switch (operation.method) {
    // A promotion attempt may pause a blocked queue without creating a task.
    case 'reorderThread': case 'patchThreadMetadata':
    case 'setTaskSubagents':
    case 'releaseSteer': case 'claimSteer': case 'claimPendingSteer': case 'acceptSteer':
    case 'createQuestion': case 'answerQuestion': case 'expireQuestions':
    case 'putArtifact': case 'promotePending': case 'enqueuePending': case 'removePending': case 'resumePending':
    case 'createClone': case 'cancelClone': case 'finishClone': case 'interruptClones':
    case 'continueTask': case 'setTaskSession': case 'createTask': case 'cancelTask':
    case 'queueTask': case 'appendTaskOutput': case 'finishTask': case 'interruptRunningTasks':
      return true;
    case 'claimClone': case 'claimNextTask': return value !== null;
    case 'getThreadMetadata': case 'listThreadMetadata':
    case 'findSteer': case 'findPendingSteer':
    case 'listQuestions':
    case 'listArtifactIds': case 'findArtifact': case 'getArtifact': case 'listArtifacts':
    case 'listPending': case 'listManagedProjects': case 'getClone': case 'getTaskSession': case 'getResumeState':
    case 'findContinuation': case 'getTask': case 'listTasks': case 'listEvents':
    case 'putAttachment': case 'getAttachment': case 'close': case 'searchHistory': return false;
  }
}
