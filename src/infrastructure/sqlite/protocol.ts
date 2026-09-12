import type { Attachment, CreateTask, ErrorCode } from '../../domain/contracts.js';
export type Operation = { method: 'createTask'; args: [CreateTask] } | { method: 'getTask' | 'cancelTask' | 'getAttachment'; args: [string] } | { method: 'listTasks'; args: [number] } | { method: 'listEvents'; args: [string, number] } | { method: 'putAttachment'; args: [Attachment] } | { method: 'close'; args: [] };
export type Request = Operation & { id: number };
export type Reply = { id: number; value?: unknown; error?: ErrorCode };
