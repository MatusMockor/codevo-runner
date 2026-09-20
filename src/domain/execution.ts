import type { ProviderSteer } from './steering.js';
import type { AgentQuestion, AgentQuestionResponse } from './questions.js';
import type { Task } from './contracts.js';

export type TaskStatus = 'draft' | 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export type OutputChannel = 'stdout' | 'stderr';
export type RegisteredProject = Readonly<{ id: string; name: string; path: string }>;
export type ProjectSummary = Readonly<{ id: string; name: string }>;
export type ExecutionResult = Readonly<{ exitCode: number | null; error?: string; sessionId?: string }>;
export const EXECUTION_LIMITS = Object.freeze({ outputEventBytes: 8192 });
export type ExecutionRequest = Readonly<{
  task: Task;
  onSteeringReady?: (handler: ProviderSteer | undefined) => void;
  onToolBoundary?: () => Promise<void>;
  resumeSessionId?: string;
  onQuestion?: (questions: readonly AgentQuestion[]) => Promise<AgentQuestionResponse>;
  onSession?: (sessionId: string) => Promise<void>;
  attachments: readonly StagedExecutionAttachment[];
  cwd: string;
  cwdIdentity?: Readonly<{ dev: number; ino: number }>;
  signal: AbortSignal;
  onOutput: (channel: OutputChannel, text: string) => Promise<void>;
}>;
export type WorkspaceDiff = Readonly<{ patch: string; truncated: boolean; untrackedFiles: readonly string[] }>;
export type StagedExecutionAttachment = Readonly<{ id: string; path: string; mediaType: 'image/png' | 'image/jpeg' }>;
