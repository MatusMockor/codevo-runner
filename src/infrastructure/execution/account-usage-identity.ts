import { createHash } from 'node:crypto';
import type { AccountUsageProvider } from '../../domain/account-usage.js';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function field(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || value.length > maximum || /[^\x20-\x7e]/.test(value)) return null;
  return value.trim() || null;
}
function emailField(value: unknown): string | null {
  const email = field(value, 320)?.toLowerCase();
  return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}
function identity(provider: AccountUsageProvider, kind: string, email: string, account: string): string {
  return 'account:v1:sha256:' + createHash('sha256').update(JSON.stringify([
    'codevo-account-usage-v1', provider, kind, email.toLowerCase(), account,
  ]), 'utf8').digest('hex');
}
export function claudeUsageIdentity(value: unknown): string | null {
  const row = record(value);
  if (!row || row.loggedIn !== true || row.authMethod !== 'claude.ai') return null;
  const email = emailField(row.email), organization = field(row.orgId, 256);
  return email && organization ? identity('claudeCode', 'claude-oauth', email, organization) : null;
}
export function codexUsageIdentity(before: unknown, usage: unknown, after: unknown): string | null {
  const account = field(record(usage)?.accountId, 256);
  if (!account) return null;
  const read = (value: unknown): string | null => {
    const row = record(value), accountRow = record(row?.account);
    if (!accountRow || accountRow.type !== 'chatgpt') return null;
    const email = emailField(accountRow.email);
    const routing = record(row?.workspaceRouting);
    if (row?.workspaceRouting !== undefined && row.workspaceRouting !== null && !routing) return null;
    if (routing && field(routing.chatgptAccountId, 256) !== account) return null;
    return email ? identity('codex', 'chatgpt', email, account) : null;
  };
  const initial = read(before), final = read(after);
  return initial !== null && initial === final ? initial : null;
}
