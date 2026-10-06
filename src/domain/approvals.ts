import { isId, RunnerError } from './contracts.js';

export const INTERACTIVE_APPROVALS = 'interactiveApprovals';

export const APPROVAL_LIMITS = Object.freeze({
  pending: 16,
  retained: 32,
  titleBytes: 256,
  detailBytes: 16 * 1024,
  facts: 8,
  factLabelBytes: 64,
  factValueBytes: 2048,
  timeoutMs: 600_000,
});

export const APPROVAL_KINDS = ['command', 'fileChange', 'tool', 'plan'] as const;
export type AgentApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_DECISIONS = ['allowOnce', 'allowForSession', 'deny'] as const;
export type AgentApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type AgentApprovalOutcome = AgentApprovalDecision | 'unanswered';

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'expired', 'timedOut'] as const;
export type AgentApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const APPROVAL_PROVIDERS = ['codex', 'claudeCode'] as const;
export type AgentApprovalProvider = (typeof APPROVAL_PROVIDERS)[number];

const ALLOWING_DECISIONS = ['allowOnce', 'allowForSession'] as const;

export interface AgentApprovalFact {
  readonly label: string;
  readonly value: string;
}

export interface AgentApprovalInput {
  readonly kind: AgentApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly detailTruncated: boolean;
  readonly facts: readonly AgentApprovalFact[];
  readonly decisions: readonly AgentApprovalDecision[];
}

interface AgentApprovalIdentity {
  readonly id: string;
  readonly taskId: string;
  readonly provider: AgentApprovalProvider;
}

type AgentApprovalSettlement =
  | { readonly status: 'pending' | 'cancelled' | 'expired' | 'timedOut'; readonly expiresAt: string }
  | { readonly status: 'approved'; readonly expiresAt: string; readonly decision: 'allowOnce' | 'allowForSession' }
  | { readonly status: 'denied'; readonly expiresAt: string; readonly decision: 'deny' };

export type AgentApprovalRequest = AgentApprovalIdentity & AgentApprovalInput & AgentApprovalSettlement;

export interface AgentApprovalAnswer {
  readonly decision: AgentApprovalDecision;
}

const REQUEST_FIELDS = ['id', 'taskId', 'provider', 'kind', 'title', 'detail', 'detailTruncated', 'facts', 'decisions', 'status', 'expiresAt'] as const;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function invalid(): never {
  throw new RunnerError('invalid_input');
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length) return invalid();
  if (!fields.every(field => Object.hasOwn(result, field))) return invalid();
  return result;
}

function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid();
  return value as T;
}

function text(value: unknown, maxBytes: number, blank: boolean): string {
  if (typeof value !== 'string' || value.length > maxBytes || value.includes('\0')) return invalid();
  if (!blank && value.trim().length === 0) return invalid();
  if (encoder.encode(value).length > maxBytes) return invalid();
  return value;
}

function identifier(value: unknown): string {
  if (!isId(value)) return invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return invalid();
  const time = Date.parse(value);
  if (Number.isNaN(time) || new Date(time).toISOString() !== value) return invalid();
  return value;
}

function parseFact(value: unknown): AgentApprovalFact {
  const fact = record(value, ['label', 'value']);
  return {
    label: text(fact.label, APPROVAL_LIMITS.factLabelBytes, false),
    value: text(fact.value, APPROVAL_LIMITS.factValueBytes, true),
  };
}

function parseFacts(value: unknown): readonly AgentApprovalFact[] {
  if (!Array.isArray(value) || value.length > APPROVAL_LIMITS.facts) return invalid();
  return value.map(parseFact);
}

function parseDecisions(value: unknown): readonly AgentApprovalDecision[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > APPROVAL_DECISIONS.length) return invalid();
  const decisions = value.map(item => member(item, APPROVAL_DECISIONS));
  if (new Set(decisions).size !== decisions.length || !decisions.includes('deny')) return invalid();
  return decisions;
}

function parseInput(item: Record<string, unknown>): AgentApprovalInput {
  if (typeof item.detailTruncated !== 'boolean') return invalid();
  return {
    kind: member(item.kind, APPROVAL_KINDS),
    title: text(item.title, APPROVAL_LIMITS.titleBytes, false),
    detail: text(item.detail, APPROVAL_LIMITS.detailBytes, true),
    detailTruncated: item.detailTruncated,
    facts: parseFacts(item.facts),
    decisions: parseDecisions(item.decisions),
  };
}

function parseSettlement(item: Record<string, unknown>, status: AgentApprovalStatus, decisions: readonly AgentApprovalDecision[]): AgentApprovalSettlement {
  const expiresAt = timestamp(item.expiresAt);
  if (status === 'approved') {
    const decision = member(item.decision, ALLOWING_DECISIONS);
    if (!decisions.includes(decision)) return invalid();
    return { status, expiresAt, decision };
  }
  if (status === 'denied') {
    if (item.decision !== 'deny') return invalid();
    return { status, expiresAt, decision: 'deny' };
  }
  return { status, expiresAt };
}

export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

export function boundedApprovalText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const cleaned = value.replaceAll('\0', '');
  const bytes = encoder.encode(cleaned);
  if (bytes.length <= maxBytes) return { text: cleaned, truncated: cleaned.length !== value.length };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

export function parseAgentApprovalRequest(value: unknown): AgentApprovalRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const status = member((value as Record<string, unknown>).status, APPROVAL_STATUSES);
  const settledByAnswer = status === 'approved' || status === 'denied';
  const item = record(value, settledByAnswer ? [...REQUEST_FIELDS, 'decision'] : REQUEST_FIELDS);
  const input = parseInput(item);
  return {
    id: identifier(item.id),
    taskId: identifier(item.taskId),
    provider: member(item.provider, APPROVAL_PROVIDERS),
    ...input,
    ...parseSettlement(item, status, input.decisions),
  };
}

export function parseAgentApprovalAnswer(value: unknown, request: Pick<AgentApprovalRequest, 'decisions'>): AgentApprovalAnswer {
  const decision = member(record(value, ['decision']).decision, APPROVAL_DECISIONS);
  if (!request.decisions.includes(decision)) return invalid();
  return { decision };
}

export function settledApproval(request: AgentApprovalRequest, decision: AgentApprovalDecision): AgentApprovalRequest {
  const { id, taskId, provider, kind, title, detail, detailTruncated, facts, decisions, expiresAt } = request;
  const base = { id, taskId, provider, kind, title, detail, detailTruncated, facts, decisions };
  if (decision === 'deny') return { ...base, status: 'denied', expiresAt, decision };
  return { ...base, status: 'approved', expiresAt, decision };
}
