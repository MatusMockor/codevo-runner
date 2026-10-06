import {
  APPROVAL_LIMITS, boundedApprovalText, hasControlCharacter,
  type AgentApprovalDecision, type AgentApprovalFact, type AgentApprovalInput, type AgentApprovalKind, type AgentApprovalOutcome,
} from '../../domain/approvals.js';

export type ClaudeSessionRule = Readonly<{ toolName: string; ruleContent?: string }>;

const MAX_SESSION_RULES = 16;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_RULE_CONTENT_BYTES = 1024;
const PLAN_TOOL = 'ExitPlanMode';
const FILE_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const DENIED_MESSAGE = 'The user denied this action.';
const KEEP_PLANNING_MESSAGE = 'The user wants to keep planning. Stay in plan mode and refine the plan.';
const UNANSWERED_MESSAGE = 'No approval decision was received, so this action was not allowed.';
const UNANSWERED_PLAN_MESSAGE = 'No decision on the plan was received. Plan mode stays active; the plan was neither approved nor rejected.';

type Description = Readonly<{ kind: AgentApprovalKind; title: string; detail: string }>;
type SessionGrant = Readonly<{ rules: readonly ClaudeSessionRule[]; scope: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  if (typeof value !== 'string') return undefined;
  return value;
}

function toolName(request: Record<string, unknown>): string | undefined {
  const tool = request.tool_name;
  if (typeof tool !== 'string' || tool.length === 0 || Buffer.byteLength(tool) > MAX_TOOL_NAME_BYTES) return undefined;
  return tool;
}

function filePreview(input: Record<string, unknown>): string {
  const body = stringField(input, 'content') ?? stringField(input, 'new_string') ?? stringField(input, 'new_source');
  if (body !== undefined) return body;
  if (!Array.isArray(input.edits)) return '';
  return input.edits.flatMap(edit => isRecord(edit) && typeof edit.new_string === 'string' ? [edit.new_string] : []).join('\n---\n');
}

function describeTool(tool: string, input: Record<string, unknown>): Description | undefined {
  if (tool === PLAN_TOOL) return { kind: 'plan', title: 'Approve the plan?', detail: stringField(input, 'plan') ?? '' };
  if (tool === 'Bash') {
    const command = stringField(input, 'command');
    if (command === undefined) return undefined;
    return { kind: 'command', title: 'Run a command?', detail: command };
  }
  if (FILE_TOOLS.includes(tool)) return { kind: 'fileChange', title: `Allow ${tool} to change a file?`, detail: filePreview(input) };
  return { kind: 'tool', title: `Allow ${tool}?`, detail: JSON.stringify(input, null, 2) };
}

function providerTitle(request: Record<string, unknown>): string | undefined {
  const title = stringField(request, 'title');
  if (title === undefined || title.trim().length === 0) return undefined;
  return title;
}

function sessionRule(value: unknown): ClaudeSessionRule | undefined {
  if (!isRecord(value)) return undefined;
  const tool = value.toolName;
  if (typeof tool !== 'string' || tool.length > MAX_TOOL_NAME_BYTES || !/^[A-Za-z0-9_.:-]+$/.test(tool)) return undefined;
  if (!Object.hasOwn(value, 'ruleContent')) return { toolName: tool };
  const content = value.ruleContent;
  if (typeof content !== 'string' || hasControlCharacter(content) || Buffer.byteLength(content) > MAX_RULE_CONTENT_BYTES) return undefined;
  return { toolName: tool, ruleContent: content };
}

function suggestedRules(suggestion: unknown): readonly unknown[] | undefined {
  if (!isRecord(suggestion) || suggestion.type !== 'addRules' || suggestion.behavior !== 'allow') return [];
  if (!Array.isArray(suggestion.rules)) return [];
  if (suggestion.rules.length > MAX_SESSION_RULES) return undefined;
  return suggestion.rules;
}

function sameToolSuggestions(request: Record<string, unknown>, tool: string): readonly unknown[] | undefined {
  const suggestions = request.permission_suggestions;
  if (!Array.isArray(suggestions) || suggestions.length > MAX_SESSION_RULES) return undefined;
  const groups = suggestions.map(suggestedRules);
  if (groups.some(group => group === undefined)) return undefined;
  return groups.flatMap(group => group ?? []).filter(rule => isRecord(rule) && rule.toolName === tool);
}

function sessionGrant(request: Record<string, unknown>, tool: string): SessionGrant | undefined {
  if (tool === PLAN_TOOL) return undefined;
  const suggested = sameToolSuggestions(request, tool);
  if (!suggested || suggested.length === 0 || suggested.length > MAX_SESSION_RULES) return undefined;
  const rules = suggested.flatMap(value => {
    const rule = sessionRule(value);
    return rule ? [rule] : [];
  });
  if (rules.length !== suggested.length) return undefined;
  const scope = sessionScope(rules);
  if (Buffer.byteLength(scope) > APPROVAL_LIMITS.factValueBytes) return undefined;
  return { rules, scope };
}

function sessionScope(rules: readonly ClaudeSessionRule[]): string {
  return rules.map(rule => {
    if (rule.ruleContent !== undefined) return `${rule.toolName}(${rule.ruleContent})`;
    if (rule.toolName === 'Bash') return 'all Bash commands';
    return `all ${rule.toolName} requests`;
  }).join(', ');
}

function facts(tool: string, input: Record<string, unknown>, request: Record<string, unknown>): AgentApprovalFact[] {
  const candidates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['Tool', tool],
    ['File', stringField(input, 'file_path') ?? stringField(input, 'notebook_path')],
    ['Purpose', stringField(input, 'description')],
    ['Blocked path', stringField(request, 'blocked_path')],
    ['Reason', stringField(request, 'decision_reason')],
    ['Details', stringField(request, 'description')],
  ];
  return candidates.flatMap(([label, value]) => {
    if (value === undefined || value.trim().length === 0) return [];
    return [{ label, value: boundedApprovalText(value, APPROVAL_LIMITS.factValueBytes).text }];
  });
}

export function claudeSessionRules(request: Record<string, unknown>, tool: string): readonly ClaudeSessionRule[] | undefined {
  return sessionGrant(request, tool)?.rules;
}

export function describeClaudePermission(request: Record<string, unknown>): AgentApprovalInput | undefined {
  const tool = toolName(request);
  if (tool === undefined || !isRecord(request.input)) return undefined;
  const description = describeTool(tool, request.input);
  if (!description) return undefined;
  const grant = sessionGrant(request, tool);
  const detail = boundedApprovalText(description.detail, APPROVAL_LIMITS.detailBytes);
  const described = facts(tool, request.input, request);
  const scope: AgentApprovalFact[] = grant ? [{ label: 'Session approval covers', value: grant.scope }] : [];
  const decisions: AgentApprovalDecision[] = grant ? ['allowOnce', 'allowForSession', 'deny'] : ['allowOnce', 'deny'];
  return {
    kind: description.kind,
    title: boundedApprovalText(providerTitle(request) ?? description.title, APPROVAL_LIMITS.titleBytes).text,
    detail: detail.text,
    detailTruncated: detail.truncated,
    facts: [...described.slice(0, APPROVAL_LIMITS.facts - scope.length), ...scope],
    decisions,
  };
}

export function claudeApprovalResponse(
  outcome: AgentApprovalOutcome,
  input: Record<string, unknown>,
  toolUseId: unknown,
  rules: readonly ClaudeSessionRule[] | undefined,
  plan: boolean,
): Record<string, unknown> {
  const unanswered = { behavior: 'deny', message: plan ? UNANSWERED_PLAN_MESSAGE : UNANSWERED_MESSAGE };
  if (outcome === 'unanswered') return unanswered;
  if (outcome === 'deny') return { behavior: 'deny', message: plan ? KEEP_PLANNING_MESSAGE : DENIED_MESSAGE };
  const allowed = { behavior: 'allow', updatedInput: input, ...(typeof toolUseId === 'string' ? { toolUseID: toolUseId } : {}) };
  if (outcome === 'allowOnce') return allowed;
  if (!rules || rules.length === 0) return unanswered;
  return { ...allowed, updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }] };
}
