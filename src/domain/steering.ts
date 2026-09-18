import { RunnerError, type MessagePart } from './contracts.js';
import { parseContinueTask } from './task-resume.js';
import type { StagedExecutionAttachment } from './execution.js';

export type SteerInput = Readonly<{ idempotencyKey: string; parts: readonly MessagePart[] }>;
export type SteerReceipt = Readonly<{ taskId: string; messageId: string; status: 'accepted' }>;
export type SteerClaim = Readonly<{ taskId: string; messageId: string; parts: readonly MessagePart[]; accepted: boolean }>;
export type ProviderSteerInput = Readonly<{ idempotencyKey: string; prompt: string; attachments: readonly StagedExecutionAttachment[] }>;
export type ProviderSteer = (input: ProviderSteerInput) => Promise<void>;
export function parseSteerInput(value: unknown): SteerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) throw new RunnerError('invalid_input');
  const input = parseContinueTask(value);
  return { idempotencyKey: input.idempotencyKey, parts: input.parts };
}

/** Definitive rejection before acceptance; callers may safely retain/retry the message. */
export class SteeringNotSent extends Error {}
