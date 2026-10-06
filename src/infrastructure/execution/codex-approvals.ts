import {
  APPROVAL_LIMITS, boundedApprovalText, hasControlCharacter,
  type AgentApprovalDecision, type AgentApprovalFact, type AgentApprovalInput, type AgentApprovalOutcome,
} from '../../domain/approvals.js';
import type { CodexExecutionMode } from '../../domain/launch.js';

export const CODEX_COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
export const CODEX_FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval';
export type CodexApprovalMethod = typeof CODEX_COMMAND_APPROVAL | typeof CODEX_FILE_CHANGE_APPROVAL;
export type CodexApprovalPolicy = 'never' | 'untrusted' | 'on-request';

const MAX_TRACKED_ITEMS = 64;
const MAX_LISTED_FILES = 20;

type CodexFileChange = Readonly<{ path: string; diff: string }>;
type CodexFilesContext = Readonly<{ type: 'files'; changes: readonly CodexFileChange[]; total: number; complete: boolean; diffTruncated: boolean }>;
type CodexItemContext = CodexFilesContext | Readonly<{ type: 'command'; command: string }>;
type ApprovalContent = Readonly<{ text: string; partial: boolean }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

function facts(candidates: ReadonlyArray<readonly [string, string | undefined]>): AgentApprovalFact[] {
  return candidates.flatMap(([label, value]) => {
    if (value === undefined) return [];
    return [{ label, value: boundedApprovalText(value, APPROVAL_LIMITS.factValueBytes).text }];
  }).slice(0, APPROVAL_LIMITS.facts);
}

function decisions(params: Record<string, unknown>): AgentApprovalDecision[] | undefined {
  const available = params.availableDecisions;
  if (available === undefined || available === null) return ['allowOnce', 'allowForSession', 'deny'];
  if (!Array.isArray(available)) return undefined;
  return [
    ...(available.includes('accept') ? ['allowOnce' as const] : []),
    ...(available.includes('acceptForSession') ? ['allowForSession' as const] : []),
    'deny',
  ];
}

function networkHost(params: Record<string, unknown>): string | undefined {
  const context = params.networkApprovalContext;
  if (!isRecord(context)) return undefined;
  return text(context, 'host');
}

function additionalPermissions(params: Record<string, unknown>): string | undefined {
  if (!isRecord(params.additionalPermissions)) return undefined;
  return JSON.stringify(params.additionalPermissions);
}

function shownExactly(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !hasControlCharacter(value) && !boundedApprovalText(value, APPROVAL_LIMITS.factValueBytes).truncated;
}

function withoutSession(offered: AgentApprovalDecision[] | undefined): AgentApprovalDecision[] | undefined {
  return offered?.filter(decision => decision !== 'allowForSession');
}

function approval(kind: AgentApprovalInput['kind'], title: string, content: ApprovalContent, described: AgentApprovalFact[], offered: AgentApprovalDecision[] | undefined): AgentApprovalInput | undefined {
  if (!offered) return undefined;
  const detail = boundedApprovalText(content.text, APPROVAL_LIMITS.detailBytes);
  return { kind, title, detail: detail.text, detailTruncated: detail.truncated || content.partial, facts: described, decisions: offered };
}

function describeStdin(params: Record<string, unknown>, items: CodexApprovalItems): AgentApprovalInput | undefined {
  const detail = text(params, 'command') ?? items.command(params.itemId) ?? '';
  return approval('command', 'Send input to a running command?', { text: detail, partial: false }, facts([
    ['Action', 'Codex wants to type into a terminal it already started.'],
    ['Directory', text(params, 'cwd')],
    ['Reason', text(params, 'reason')],
  ]), decisions(params));
}

function describeCommand(params: Record<string, unknown>, items: CodexApprovalItems): AgentApprovalInput | undefined {
  const kind = params.kind ?? 'command';
  if (kind === 'writeStdin') return describeStdin(params, items);
  if (kind !== 'command') return undefined;
  const host = networkHost(params);
  const command = text(params, 'command');
  if (command === undefined && host === undefined) return undefined;
  return approval('command', host === undefined ? 'Run a command?' : 'Allow network access?', { text: command ?? '', partial: false }, facts([
    ['Directory', text(params, 'cwd')],
    ['Reason', text(params, 'reason')],
    ['Network host', host],
    ['Additional permissions', additionalPermissions(params)],
  ]), shownExactly(host) ? decisions(params) : withoutSession(decisions(params)));
}

function fileChangeFacts(params: Record<string, unknown>, listed: boolean): AgentApprovalFact[] {
  return facts([
    ['Files', listed ? undefined : 'Codex did not list the files for this change.'],
    ['Reason', text(params, 'reason')],
    ['Write access requested for', text(params, 'grantRoot')],
  ]);
}

function fileListing(files: CodexFilesContext): string {
  const omitted = files.total - files.changes.length;
  return [...files.changes.map(change => change.path), ...(omitted > 0 ? [`+${omitted} more`] : [])].join('\n');
}

function fileDiffs(files: CodexFilesContext): string {
  return files.changes.filter(change => change.diff.length > 0).map(change => `${change.path}:\n${change.diff}`).join('\n\n');
}

function describeFileChange(params: Record<string, unknown>, items: CodexApprovalItems): AgentApprovalInput | undefined {
  const files = items.files(params.itemId);
  if (!files || files.changes.length === 0) {
    return approval('fileChange', 'Apply file changes?', { text: '', partial: false }, fileChangeFacts(params, false), withoutSession(decisions(params)));
  }
  const listing = fileListing(files);
  const diffs = fileDiffs(files);
  const scopeShown = files.complete && shownExactly(text(params, 'grantRoot')) && !boundedApprovalText(listing, APPROVAL_LIMITS.detailBytes).truncated;
  const content = { text: diffs.length > 0 ? `${listing}\n\n${diffs}` : listing, partial: !files.complete || files.diffTruncated };
  const offered = decisions(params);
  return approval('fileChange', 'Apply file changes?', content, fileChangeFacts(params, true), scopeShown ? offered : withoutSession(offered));
}

export class CodexApprovalItems {
  private readonly entries = new Map<string, CodexItemContext>();

  observe(id: string, item: Record<string, unknown>): void {
    const context = itemContext(item);
    if (!context) return;
    this.entries.delete(id);
    const oldest = this.entries.keys().next();
    if (this.entries.size >= MAX_TRACKED_ITEMS && !oldest.done) this.entries.delete(oldest.value);
    this.entries.set(id, context);
  }

  files(itemId: unknown): CodexFilesContext | undefined {
    const context = typeof itemId === 'string' ? this.entries.get(itemId) : undefined;
    if (context?.type !== 'files') return undefined;
    return context;
  }

  command(itemId: unknown): string | undefined {
    const context = typeof itemId === 'string' ? this.entries.get(itemId) : undefined;
    if (context?.type !== 'command') return undefined;
    return context.command;
  }
}

function filesContext(changes: readonly unknown[]): CodexFilesContext {
  const listed: CodexFileChange[] = [];
  let diffBudget = APPROVAL_LIMITS.detailBytes;
  let complete = changes.length <= MAX_LISTED_FILES;
  let diffTruncated = false;
  for (const change of changes.slice(0, MAX_LISTED_FILES)) {
    if (!isRecord(change) || typeof change.path !== 'string' || change.path.trim().length === 0 || hasControlCharacter(change.path)) {
      complete = false;
      continue;
    }
    const path = boundedApprovalText(change.path, APPROVAL_LIMITS.factValueBytes);
    const diff = boundedApprovalText(typeof change.diff === 'string' ? change.diff : '', diffBudget);
    diffBudget -= Buffer.byteLength(diff.text);
    complete &&= !path.truncated;
    diffTruncated ||= diff.truncated;
    listed.push({ path: path.text, diff: diff.text });
  }
  return { type: 'files', changes: listed, total: changes.length, complete, diffTruncated };
}

function itemContext(item: Record<string, unknown>): CodexItemContext | undefined {
  if (item.type === 'fileChange' && Array.isArray(item.changes)) return filesContext(item.changes);
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    return { type: 'command', command: boundedApprovalText(item.command, APPROVAL_LIMITS.detailBytes).text };
  }
  return undefined;
}

export function isCodexApprovalMethod(method: unknown): method is CodexApprovalMethod {
  return method === CODEX_COMMAND_APPROVAL || method === CODEX_FILE_CHANGE_APPROVAL;
}

export function describeCodexApproval(method: CodexApprovalMethod, params: Record<string, unknown>, items: CodexApprovalItems): AgentApprovalInput | undefined {
  if (method === CODEX_COMMAND_APPROVAL) return describeCommand(params, items);
  return describeFileChange(params, items);
}

export function codexApprovalResult(outcome: AgentApprovalOutcome): Readonly<{ decision: 'accept' | 'acceptForSession' | 'decline' }> {
  if (outcome === 'allowOnce') return { decision: 'accept' };
  if (outcome === 'allowForSession') return { decision: 'acceptForSession' };
  return { decision: 'decline' };
}

export function codexDeclineResult(method: unknown): Record<string, unknown> | undefined {
  if (isCodexApprovalMethod(method)) return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  return undefined;
}

export function codexApprovalPolicy(mode: CodexExecutionMode | undefined, interactive: boolean): CodexApprovalPolicy {
  if (!interactive) return 'never';
  switch (mode) {
    case 'workspaceWrite': return 'untrusted';
    case 'auto': return 'on-request';
    case undefined: case 'default': case 'readOnly': case 'dangerFullAccess': return 'never';
  }
}
