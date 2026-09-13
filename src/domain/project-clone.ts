import { isId, RunnerError } from './contracts.js';
export type CloneInput = Readonly<{ idempotencyKey: string; url: string; name: string; branch?: string }>;
export type CloneStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export type CloneJob = Readonly<{ id: string; status: CloneStatus; project: Readonly<{ id: string; name: string }> | null; error: string | null }>;
export type StoredClone = Readonly<{ job: CloneJob; input: CloneInput }>;
const host = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?';
export function validCloneUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return false;
  const match = new RegExp(`^(?:https://${host}|ssh://[A-Za-z0-9_][A-Za-z0-9_-]{0,63}@${host}(?::[0-9]{1,5})?)/([A-Za-z0-9._/-]+)$`).exec(value)
    ?? new RegExp(`^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}@${host}:([A-Za-z0-9._/-]+)$`).exec(value);
  if (!match || !match[1] || match[1].split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (value.startsWith('ssh://')) {
    try { const port = new URL(value).port; if (port && (Number(port) < 1 || Number(port) > 65535)) return false; }
    catch { return false; }
  }
  return true;
}
export function validCloneBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    !value.includes('//') && !value.startsWith('-') && !value.startsWith('/') && !/[/.]$/.test(value) &&
    value !== '@' && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}
export function parseCloneInput(value: unknown): CloneInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['idempotencyKey', 'url', 'name', 'branch'].includes(key)) ||
      (!isId(v.idempotencyKey) || v.idempotencyKey.length !== 36) || !validCloneUrl(v.url) || typeof v.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.name) || /[\r\n]/.test(v.name) ||
      (v.branch !== undefined && !validCloneBranch(v.branch))) throw new RunnerError('invalid_input');
  return { idempotencyKey: v.idempotencyKey, url: v.url, name: v.name, ...(v.branch === undefined ? {} : { branch: v.branch as string }) };
}
