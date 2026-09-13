import { parseLaunchOptions } from './launch.js';
import { isId, LIMITS, RunnerError, type CreateTask, type MessagePart } from './contracts.js';

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RunnerError('invalid_input');
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new RunnerError('invalid_input');
  return result;
}

export function parseTaskInput(value: unknown): CreateTask {
  const hasLaunch = typeof value === 'object' && value !== null && Object.hasOwn(value, 'launch');
  const input = record(value, ['idempotencyKey', 'provider', 'parts', ...(hasLaunch ? ['launch'] : [])]);
  if (!isId(input.idempotencyKey) || (input.provider !== 'codex' && input.provider !== 'claude'))
    throw new RunnerError('invalid_input');
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > LIMITS.parts)
    throw new RunnerError('invalid_input');
  let textBytes = 0;
  const attachments = new Set<string>();
  const encoder = new TextEncoder();
  const parts: MessagePart[] = input.parts.map((value: unknown) => {
    if (typeof value !== 'object' || value === null || !('type' in value)) throw new RunnerError('invalid_input');
    if (value.type === 'text') {
      const part = record(value, ['type', 'text']);
      if (typeof part.text !== 'string') throw new RunnerError('invalid_input');
      if (part.text.length > LIMITS.textBytes) throw new RunnerError('too_large');
      if (!part.text.trim()) throw new RunnerError('invalid_input');
      textBytes += encoder.encode(part.text).byteLength;
      if (textBytes > LIMITS.textBytes) throw new RunnerError('too_large');
      return Object.freeze({ type: 'text', text: part.text });
    }
    if (value.type === 'attachment') {
      const part = record(value, ['type', 'attachmentId']);
      if (!isId(part.attachmentId) || attachments.has(part.attachmentId)) throw new RunnerError('invalid_input');
      attachments.add(part.attachmentId);
      if (attachments.size > LIMITS.attachmentsPerTask) throw new RunnerError('too_large');
      return Object.freeze({ type: 'attachment', attachmentId: part.attachmentId });
    }
    throw new RunnerError('invalid_input');
  });
  return Object.freeze({ idempotencyKey: input.idempotencyKey, provider: input.provider, parts: Object.freeze(parts), ...(hasLaunch ? { launch: parseLaunchOptions(input.launch, input.provider) } : {}) });
}

export function validateCursor(after: number): number {
  if (!Number.isSafeInteger(after) || after < 0) throw new RunnerError('invalid_input');
  return after;
}
export function validateId(id: string): string {
  if (!isId(id)) throw new RunnerError('invalid_input');
  return id;
}
