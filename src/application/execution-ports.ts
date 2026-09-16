import type { InstructionSnapshot } from '../domain/instructions.js';
import type { PendingMessage, PendingMessages } from '../domain/pending-message.js';
import type { WorkspaceFiles, WorkspaceFileDiff } from '../domain/workspace-files.js';
import type { ContinueTask, ResumeState, TaskSession } from '../domain/task-resume.js';
import type { Task } from '../domain/contracts.js';
import type { ExecutionRequest, ExecutionResult, OutputChannel, ProjectSummary, RegisteredProject, WorkspaceDiff, StagedExecutionAttachment } from '../domain/execution.js';

/** Each state change and its event must commit atomically. Terminal state wins races. */
export interface ExecutionRepository {
  enqueuePending(taskId: string, input: ContinueTask): Promise<{ pending: PendingMessage; created: boolean }>;
  listPending(taskId: string): Promise<PendingMessages>;
  removePending(taskId: string, pendingId: string): Promise<PendingMessage>;
  resumePending(taskId: string): Promise<PendingMessages>;
  promotePending(): Promise<Task | null>;
  getResumeState(taskId: string): Promise<ResumeState>;
  getTaskSession(taskId: string): Promise<TaskSession>;
  setTaskSession(taskId: string, sessionId: string): Promise<void>;
  findContinuation(taskId: string, input: ContinueTask): Promise<Readonly<{ task: Task; created: false }> | null>;
  continueTask(taskId: string, input: ContinueTask): Promise<Readonly<{ task: Task; created: boolean }>>;
  queueTask(taskId: string, projectId: string): Promise<Task>;
  claimNextTask(): Promise<Task | null>;
  appendTaskOutput(taskId: string, channel: OutputChannel, text: string): Promise<void>;
  finishTask(taskId: string, result: ExecutionResult): Promise<Task>;
  interruptRunningTasks(): Promise<void>;
}
/** Registration comes from trusted host configuration, never a client filesystem path. */
export interface ProjectRegistry {
  list(): Promise<readonly ProjectSummary[]>;
  get(id: string): Promise<RegisteredProject>;
}
/** Creates a task-owned checkout and returns its server-local working directory. */
export interface ProjectWorkspace {
  prepare(project: RegisteredProject, taskId: string, signal?: AbortSignal): Promise<string>;
  diff(taskId: string): Promise<WorkspaceDiff>;
  files(project: RegisteredProject, taskId: string): Promise<WorkspaceFiles>;
  fileDiff(project: RegisteredProject, taskId: string, path: string): Promise<WorkspaceFileDiff>;
  resume(project: RegisteredProject, workspaceTaskId: string, signal?: AbortSignal): Promise<string>;
}
/** Adapter owns its child process group and waits for it to stop before settling. */
export interface ProviderExecutor {
  readonly provider: 'codex' | 'claude';
  readonly supportsAttachments: boolean;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
export interface ExecutionApplication {
  enqueue(taskId: string, input: unknown): Promise<{ pending: PendingMessage; created: boolean }>;
  pending(taskId: string): Promise<PendingMessages>;
  removePending(taskId: string, pendingId: string): Promise<PendingMessage>;
  resumePending(taskId: string): Promise<PendingMessages>;
  start(taskId: string, input: unknown): Promise<Task>;
  resumeState(taskId: string): Promise<ResumeState>;
  continue(taskId: string, input: unknown): Promise<Readonly<{ task: Task; created: boolean }>>;
  cancel(taskId: string): Promise<Task>;
  projects(): Promise<readonly ProjectSummary[]>;
  diff(taskId: string): Promise<WorkspaceDiff>;
  files(taskId: string): Promise<WorkspaceFiles>;
  fileDiff(taskId: string, input: unknown): Promise<WorkspaceFileDiff>;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface StagedExecutionInputs {
  readonly attachments: readonly StagedExecutionAttachment[];
  cleanup(): Promise<void>;
}
export interface ExecutionAttachmentStager {
  stage(taskId: string, attachmentIds: readonly string[]): Promise<StagedExecutionInputs>;
}

export interface InstructionWorkspace {
  apply(workspaceTaskId: string, cwd: string, snapshot: InstructionSnapshot, signal: AbortSignal): Promise<void>;
}
