import type { QuestionService } from './question-service.js';
import { ProviderArtifactReferences } from '../domain/artifact-output.js';
import { parseWorkspaceFileInput } from '../domain/workspace-files.js';
import { parseContinueTask } from '../domain/task-resume.js';
import { RunnerError, type Task } from '../domain/contracts.js';
import { validateId } from '../domain/task-input.js';
import type { InstructionWorkspace, ProviderExecutor, ExecutionApplication, ExecutionAttachmentStager, ExecutionRepository, ProjectRegistry, ProjectWorkspace, StagedExecutionInputs } from './execution-ports.js';
import type { TaskRepository } from './ports.js';

/** A single runner owns durable admission and one detached worker, independent of HTTP. */
export class ExecutionService implements ExecutionApplication {
  private initialized = false;
  private closing = false;
  private worker: Promise<void> | undefined;
  private active: { taskId: string; abort: AbortController } | undefined;
  private wakeRequested = false;
  private workerFailure: unknown;

  constructor(
    private readonly tasks: TaskRepository,
    private readonly executions: ExecutionRepository,
    private readonly registry: ProjectRegistry,
    private readonly workspaces: ProjectWorkspace,
    private readonly providers: readonly ProviderExecutor[],
    private readonly attachments?: ExecutionAttachmentStager,
    private readonly captureArtifacts?: (taskId: string, paths: readonly string[]) => Promise<boolean>,
    private readonly instructions?: InstructionWorkspace,
    private readonly questions?: QuestionService,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.executions.interruptRunningTasks();
    this.initialized = true;
    this.wake();
  }

  async pending(taskId: string) {
    this.assertAvailable();
    return this.executions.listPending(validateId(taskId));
  }

  async enqueue(taskId: string, input: unknown) {
    this.assertAvailable();
    validateId(taskId);
    const parsed = parseContinueTask(input);
    const task = await this.tasks.getTask(taskId);
    this.executorFor({ ...task, parts: parsed.parts });
    const result = await this.executions.enqueuePending(taskId, parsed);
    this.wake();
    return result;
  }

  async removePending(taskId: string, pendingId: string) {
    this.assertAvailable();
    return this.executions.removePending(validateId(taskId), validateId(pendingId));
  }

  async resumePending(taskId: string) {
    this.assertAvailable();
    validateId(taskId);
    const result = await this.executions.resumePending(taskId);
    this.wake();
    return result;
  }

  async start(taskId: string, input: unknown): Promise<Task> {
    this.assertAvailable();
    validateId(taskId);
    const projectId = parseProjectId(input);
    await this.registry.get(projectId);
    const task = await this.tasks.getTask(taskId);
    this.executorFor(task);
    const queued = await this.executions.queueTask(taskId, projectId);
    this.wake();
    return queued;
  }

  async resumeState(taskId: string) {
    this.assertAvailable();
    validateId(taskId);
    const state = await this.executions.getResumeState(taskId);
    if (!state.available) return state;
    const task = await this.tasks.getTask(taskId);
    const session = await this.executions.getTaskSession(taskId);
    try {
      if (!task.projectId) throw new RunnerError('conflict');
      await this.workspaces.resume(await this.registry.get(task.projectId), session.workspaceTaskId);
    } catch { return { available: false, reason: 'session_unavailable' as const }; }
    return this.executions.getResumeState(taskId);
  }

  async continue(taskId: string, input: unknown) {
    this.assertAvailable();
    validateId(taskId);
    const parsed = parseContinueTask(input);
    const previous = await this.executions.findContinuation(taskId, parsed);
    if (previous) return previous;
    const task = await this.tasks.getTask(taskId);
    this.executorFor({ ...task, parts: parsed.parts });
    if (!task.projectId) throw new RunnerError('conflict');
    const session = await this.executions.getTaskSession(taskId);
    await this.workspaces.resume(await this.registry.get(task.projectId), session.workspaceTaskId);
    const result = await this.executions.continueTask(taskId, parsed);
    this.wake();
    return result;
  }

  async cancel(taskId: string): Promise<Task> {
    validateId(taskId);
    const task = await this.tasks.cancelTask(taskId);
    if (task.status === 'cancelled' && this.active?.taskId === taskId) this.active.abort.abort();
    return task;
  }

  projects() { return this.registry.list(); }

  async diff(taskId: string) {
    const task = await this.tasks.getTask(validateId(taskId));
    if (!task.projectId) throw new RunnerError('conflict');
    return this.workspaces.diff((await this.executions.getTaskSession(taskId)).workspaceTaskId);
  }

  async files(taskId: string) {
    const { project, workspaceTaskId } = await this.reviewContext(taskId);
    return this.workspaces.files(project, workspaceTaskId);
  }

  async fileDiff(taskId: string, input: unknown) {
    const path = parseWorkspaceFileInput(input);
    const { project, workspaceTaskId } = await this.reviewContext(taskId);
    return this.workspaces.fileDiff(project, workspaceTaskId, path);
  }

  private async reviewContext(taskId: string) {
    this.assertAvailable();
    const task = await this.tasks.getTask(validateId(taskId));
    if (!task.projectId) throw new RunnerError('conflict');
    const project = await this.registry.get(task.projectId);
    const { workspaceTaskId } = await this.executions.getTaskSession(taskId);
    return { project, workspaceTaskId };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.active?.abort.abort();
    await this.worker;
    await this.executions.interruptRunningTasks();
  }

  private assertAvailable(): void {
    if (!this.initialized || this.closing || this.workerFailure) throw new RunnerError('busy');
  }

  private executorFor(task: Task): ProviderExecutor {
    const executor = this.providers.find((candidate) => candidate.provider === task.provider);
    if (!executor) throw new RunnerError('invalid_input');
    const hasImages = task.parts.some((part) => part.type === 'attachment');
    if (hasImages && (!executor.supportsAttachments || !this.attachments)) throw new RunnerError('unsupported_media');
    return executor;
  }

  private wake(): void {
    this.wakeRequested = true;
    if (this.worker || this.closing) return;
    this.worker = this.drain().catch((error: unknown) => {
      // Persistence errors stop admission instead of acknowledging work we cannot own.
      this.workerFailure = error;
    }).finally(() => {
      this.worker = undefined;
      if (this.wakeRequested && !this.closing && !this.workerFailure) this.wake();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closing) {
      this.wakeRequested = false;
      await this.executions.promotePending();
      if (this.closing) return;
      const task = await this.executions.claimNextTask();
      if (!task) return;
      await this.run(task);
    }
  }

  private async run(task: Task): Promise<void> {
    const abort = new AbortController();
    this.active = { taskId: task.id, abort };
    if (this.closing) abort.abort();
    let inputs: StagedExecutionInputs | undefined;
    let syncingInstructions = false;
    try {
      if ((await this.tasks.getTask(task.id)).status !== 'running') return;
      if (!task.projectId) throw new RunnerError('invalid_input');
      const executor = this.executorFor(task);
      const project = await this.registry.get(task.projectId);
      const session = await this.executions.getTaskSession(task.id);
      if (task.parentTaskId && !session.sessionId) throw new RunnerError('conflict');
      const cwd = task.parentTaskId
        ? await this.workspaces.resume(project, session.workspaceTaskId, abort.signal)
        : await this.workspaces.prepare(project, task.id, abort.signal);
      abort.signal.throwIfAborted();
      if (task.instructions !== undefined) {
        syncingInstructions = true;
        if (!this.instructions) throw new RunnerError('invalid_input');
        await this.instructions.apply(session.workspaceTaskId, cwd, task.instructions, abort.signal);
        syncingInstructions = false;
        abort.signal.throwIfAborted();
      }
      const ids = task.parts.flatMap((part) => part.type === 'attachment' ? [part.attachmentId] : []);
      if (ids.length > 0) inputs = await this.attachments!.stage(task.id, ids);
      abort.signal.throwIfAborted();
      const artifactReferences = new ProviderArtifactReferences(task.provider);
      const result = await executor.execute({ task, cwd, ...(task.parentTaskId && session.sessionId ? { resumeSessionId: session.sessionId } : {}), signal: abort.signal, attachments: inputs?.attachments ?? [],
        ...(this.questions ? { onQuestion: (questions: Parameters<QuestionService['ask']>[1]) => this.questions!.ask(task, questions, abort.signal) } : {}),
        onSession: async (sessionId) => {
          abort.signal.throwIfAborted();
          await this.executions.setTaskSession(task.id, sessionId);
        },
        onOutput: async (channel, text) => {
          abort.signal.throwIfAborted();
          if (channel === 'stdout') artifactReferences.push(text);
          await this.executions.appendTaskOutput(task.id, channel, text);
        },
      });
      if (result.sessionId) await this.executions.setTaskSession(task.id, result.sessionId);
      if (!this.closing && this.captureArtifacts) {
        let complete = false;
        try { complete = await this.captureArtifacts(task.id, artifactReferences.finish()); complete = complete && artifactReferences.isComplete(); } catch { /* Artifact failure does not falsify provider completion. */ }
        if (!complete) await this.executions.appendTaskOutput(task.id, 'stderr', '[Codevo] Some output previews could not be saved.\n');
      }
      if (!this.closing) await this.executions.finishTask(task.id, result);
    } catch {
      // Do not persist raw exception strings: they may contain credentials or host paths.
      if (!this.closing) await this.executions.finishTask(task.id, { exitCode: null, error: syncingInstructions ? 'instruction_sync_failed' : 'execution_failed' });
    } finally {
      abort.abort();
      try {
        try { await this.questions?.expire(task.id); }
        finally { await inputs?.cleanup(); }
      }
      finally { this.active = undefined; }
    }
  }
}

function parseProjectId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RunnerError('invalid_input');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.projectId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.projectId)) throw new RunnerError('invalid_input');
  return record.projectId;
}
