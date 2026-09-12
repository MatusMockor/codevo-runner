import type { ExecutionResult, OutputChannel } from '../../domain/execution.js';
import type { Attachment, CreateTask, ErrorCode } from '../../domain/contracts.js';
export type Operation = { method: 'createTask'; args: [CreateTask] } | { method: 'getTask' | 'cancelTask' | 'getAttachment'; args: [string] } | { method: 'listTasks'; args: [number] } | { method: 'listEvents'; args: [string, number] } | { method: 'putAttachment'; args: [Attachment] } | { method: 'close' | 'claimNextTask' | 'interruptRunningTasks'; args: [] } | { method: 'queueTask'; args: [string, string] } | { method: 'appendTaskOutput'; args: [string, OutputChannel, string] } | { method: 'finishTask'; args: [string, ExecutionResult] };
export type Request = Operation & { id: number };
export type Reply = { id: number; value?: unknown; error?: ErrorCode };
