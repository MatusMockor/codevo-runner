export type AgentTurnEvent =
 | {kind:'toolCall'; toolId:string; name:string; description?:string; inputSummary:string; parentToolId?:string}
 | {kind:'toolResult'; toolId:string; isError:boolean; parentToolId?:string}
 | {kind:'assistantText'; text:string; parentToolId?:string}
 | {kind:'userMessage'}
 | {kind:'result'}
 | {kind:'subagent'; toolId?:string; taskId?:string; status:'starting'|'running'|'completed'|'failed'|'interrupted'; subagentType?:string; description?:string; durationMs?:number; totalTokens?:number; toolUses?:number; lastToolName?:string}
 | {kind:'subagentActivity'; agentThreadId:string; agentPath:string; activity:'started'|'interacted'|'interrupted'|'completed'}
 | {kind:'subagentTurnDone'; agentThreadId:string; durationMs:number|null; isError:boolean};

type SubagentEventIdentity = Readonly<{ toolId?: string; taskId?: string; agentThreadId?: string }>;

/** Wire contract shared with the editor: test/fixtures/agent-subagent-lifecycle-wire.json. */
export const MAX_RETAINED_SUBAGENTS = 32;
export const MAX_SUBAGENT_TASK_TITLE_CHARACTERS = 120;
export const MAX_SUBAGENT_TASK_TITLE_BYTES = MAX_SUBAGENT_TASK_TITLE_CHARACTERS * 4;
export const MAX_SUBAGENT_BATCH_KEY_BYTES = 272;
export const MAX_SUBAGENT_PARENT_TOOL_ID_BYTES = 256;
export const MAX_SUBAGENT_NESTED_COUNT = 999;
export const MAX_SUBAGENT_COUNTED_NESTED_IDS = 32;
/** Clients announcing this capability receive the retained detail fields. */
export const SUBAGENT_LIFECYCLE_RETENTION = 'subagentLifecycleRetention';
const MAX_NESTED_ANCESTOR_DEPTH = 8;
const SPAWN_BATCH_KEY_PREFIX = 'spawn:';
export type AgentSubagentLifecycleState = "running" | "completed" | "failed" | "interrupted";
export interface AgentSubagentLifecycleEntry {
  readonly id: string;
  readonly toolId?: string;
  readonly taskId?: string;
  readonly agentThreadId?: string;
  readonly name: string;
  readonly description: string;
  readonly state: AgentSubagentLifecycleState;
  readonly telemetryState?: AgentSubagentLifecycleState;
  readonly resultState?: "completed" | "failed";
  readonly durationMs?: number;
  readonly totalTokens?: number;
  readonly steps?: number;
  readonly lastToolName?: string;
  readonly taskTitle?: string;
  readonly batchKey?: string;
  readonly nestedCount?: number;
  readonly parentToolId?: string;
}
export interface AgentSubagentLifecycle {
  readonly entries: ReadonlyArray<AgentSubagentLifecycleEntry>;
  readonly truncated: boolean;
  readonly openBatchKey?: string;
  readonly countedNestedToolIds?: ReadonlyArray<string>;
}
const encoder = new TextEncoder();
function clip(value: string, bytes: number): string {
  const encoded = encoder.encode(value);
  if (encoded.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
function validId(id: string | undefined): id is string {
  return id !== undefined && id.length > 0 && encoder.encode(id).length <= 256;
}
function spawn(name: string): boolean {
  return name === "Task" || name === "Agent" || name === "SpawnAgent" || name === "spawn_agent";
}

/** A spawn batch stays open until the assistant step that opened it produces other work. */
function closesSpawnBatch(event: AgentTurnEvent): boolean {
  switch (event.kind) {
    case "toolCall":
      return event.parentToolId === undefined && !spawn(event.name);
    case "assistantText":
      return event.parentToolId === undefined && event.text.trim() !== "";
    case "toolResult":
      return event.parentToolId === undefined;
    case "userMessage":
    case "result":
      return true;
    default:
      return false;
  }
}

function spawnBatchKey(toolId: string | undefined): string | undefined {
  return validId(toolId) ? `${SPAWN_BATCH_KEY_PREFIX}${toolId}` : undefined;
}

/** The spawn title is written once; later progress frames only rewrite the description. */
function taskTitleOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const line = value.trim().replace(/\s+/gu, " ");
  if (line === "") return undefined;
  return [...line].slice(0, MAX_SUBAGENT_TASK_TITLE_CHARACTERS).join("");
}

function subagentEventIdentity(event: AgentTurnEvent): SubagentEventIdentity | null {
  switch (event.kind) {
    case "toolCall":
      return event.parentToolId === undefined && spawn(event.name) ? { toolId: event.toolId } : null;
    case "toolResult":
      return event.parentToolId === undefined ? { toolId: event.toolId } : null;
    case "subagent":
      return { toolId: event.toolId, taskId: event.taskId };
    case "subagentActivity":
    case "subagentTurnDone":
      return { agentThreadId: event.agentThreadId };
    default:
      return null;
  }
}

function nestedRoot(
  entries: ReadonlyMap<string, AgentSubagentLifecycleEntry>,
  parentToolId: string,
): AgentSubagentLifecycleEntry | undefined {
  let toolId: string | undefined = parentToolId;
  for (let depth = 0; depth < MAX_NESTED_ANCESTOR_DEPTH && toolId !== undefined; depth += 1) {
    const current: string = toolId;
    const parent = [...entries.values()].find((entry) => entry.toolId === current);
    if (parent === undefined) return undefined;
    if (parent.parentToolId === undefined) return parent;
    toolId = parent.parentToolId;
  }
  return undefined;
}

function rememberCountedNested(counted: Set<string>, toolId: string): void {
  counted.add(toolId);
  for (const oldest of counted) {
    if (counted.size <= MAX_SUBAGENT_COUNTED_NESTED_IDS) break;
    counted.delete(oldest);
  }
}

/** One alias-aware lookup for every path: a second entry for a known identity is unwritable. */
function resolveAlias(
  entries: Map<string, AgentSubagentLifecycleEntry>,
  identity: SubagentEventIdentity,
): AgentSubagentLifecycleEntry | undefined {
  const { toolId, taskId, agentThreadId } = identity;
  const [first, ...aliases] = [...entries.values()].filter(
    (entry) =>
      (toolId !== undefined && entry.toolId === toolId) ||
      (taskId !== undefined && entry.taskId === taskId) ||
      (agentThreadId !== undefined && entry.agentThreadId === agentThreadId),
  );
  if (first === undefined) return undefined;
  let found = first;
  for (const alias of aliases) {
    entries.delete(alias.id);
    found = mergeAliases(found, alias);
  }
  entries.set(found.id, found);
  return found;
}

/** Replayed nested spawns must not inflate the ancestor count once the entry cap is reached. */
function retainNestedSpawn(
  entries: Map<string, AgentSubagentLifecycleEntry>,
  counted: Set<string>,
  event: Extract<AgentTurnEvent, { kind: "toolCall" }>,
  parentToolId: string,
): "retained" | "truncated" {
  if (!validId(event.toolId) || !validId(parentToolId)) return "truncated";
  const existing = resolveAlias(entries, { toolId: event.toolId });
  if (existing?.parentToolId !== undefined) return "retained";
  if (counted.has(event.toolId)) return "retained";
  const root = nestedRoot(entries, parentToolId);
  if (root === undefined) return "truncated";
  if (existing?.id === root.id) return "retained";
  entries.set(root.id, { ...root, nestedCount: Math.min(MAX_SUBAGENT_NESTED_COUNT, (root.nestedCount ?? 0) + 1) });
  const description = clip(event.description ?? event.inputSummary, 512);
  const taskTitle = existing?.taskTitle ?? taskTitleOf(event.description ?? event.inputSummary);
  if (existing !== undefined) {
    entries.set(existing.id, {
      ...existing,
      parentToolId,
      description: existing.description || description,
      ...(taskTitle === undefined ? {} : { taskTitle }),
    });
    return "retained";
  }
  if (entries.size >= MAX_RETAINED_SUBAGENTS) {
    rememberCountedNested(counted, event.toolId);
    return "truncated";
  }
  entries.set(`tool:${event.toolId}`, {
    id: `tool:${event.toolId}`,
    toolId: event.toolId,
    parentToolId,
    name: clip(event.name, 128),
    description,
    state: "running",
    ...(taskTitle === undefined ? {} : { taskTitle }),
  });
  return "retained";
}

/** Lifecycle-only metadata outlives the bounded output window; terminal entries are tombstones. */
export function retainAgentSubagentLifecycle(
  previous: AgentSubagentLifecycle | undefined,
  events: ReadonlyArray<AgentTurnEvent>,
): AgentSubagentLifecycle | undefined {
  const entries = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const counted = new Set(previous?.countedNestedToolIds ?? []);
  let truncated = previous?.truncated ?? false;
  let openBatchKey = previous?.openBatchKey;
  let changed = false;
  for (const event of events) {
    if (openBatchKey !== undefined && closesSpawnBatch(event)) {
      openBatchKey = undefined;
      changed = true;
    }
    if (event.kind === "toolCall" && event.parentToolId !== undefined && spawn(event.name)) {
      if (retainNestedSpawn(entries, counted, event, event.parentToolId) === "truncated") truncated = true;
      changed = true;
      continue;
    }
    // Codex child thread telemetry is authoritative. Spawn-tool acknowledgements
    // have no child identity and must not count as additional agents.
    if (event.kind === "subagentActivity" || event.kind === "subagentTurnDone") {
      for (const [id, entry] of entries) {
        if (entry.name === "spawn_agent" || entry.name === "SpawnAgent") entries.delete(id);
      }
    }
    if (
      event.kind === "toolCall" &&
      (event.name === "spawn_agent" || event.name === "SpawnAgent") &&
      [...entries.values()].some((entry) => entry.agentThreadId !== undefined)
    )
      continue;
    const identity = subagentEventIdentity(event);
    if (identity === null) continue;
    const { toolId, taskId, agentThreadId } = identity;
    const found = resolveAlias(entries, identity);
    if (event.kind === "toolResult" && found === undefined) continue;
    const key =
      found?.id ??
      (validId(toolId)
        ? `tool:${toolId}`
        : validId(taskId)
          ? `task:${taskId}`
          : validId(agentThreadId)
            ? `thread:${agentThreadId}`
            : null);
    if (key === null) {
      truncated = true;
      changed = true;
      continue;
    }
    if (found === undefined && entries.size >= MAX_RETAINED_SUBAGENTS) {
      truncated = true;
      changed = true;
      continue;
    }
    let entry: AgentSubagentLifecycleEntry = found ?? {
      id: key,
      name: "subagent",
      description: "",
      state: "running",
    };
    entry = {
      ...entry,
      ...(validId(toolId) ? { toolId } : {}),
      ...(validId(taskId) ? { taskId } : {}),
      ...(validId(agentThreadId) ? { agentThreadId } : {}),
    };
    if (event.kind === "toolCall") {
      const taskTitle = entry.taskTitle ?? taskTitleOf(event.description ?? event.inputSummary);
      if (entry.batchKey === undefined) openBatchKey ??= spawnBatchKey(toolId);
      const batchKey = entry.batchKey ?? openBatchKey;
      entry = {
        ...entry,
        name: clip(event.name, 128),
        description: clip(event.description ?? event.inputSummary, 512),
        ...(taskTitle === undefined ? {} : { taskTitle }),
        ...(batchKey === undefined ? {} : { batchKey }),
      };
    }
    if (event.kind === "subagent" && event.status === "starting" && entry.taskTitle === undefined) {
      const taskTitle = taskTitleOf(event.description);
      entry = { ...entry, ...(taskTitle === undefined ? {} : { taskTitle }) };
    }
    if (event.kind === "toolResult" && entry.resultState === undefined)
      entry = { ...entry, resultState: event.isError ? "failed" : "completed" };
    if (event.kind === "subagent") {
      const next = event.status === "starting" ? "running" : event.status;
      const telemetryState =
        entry.telemetryState === "failed"
          ? "failed"
          : (entry.telemetryState === "completed" || entry.telemetryState === "interrupted") && next === "running"
            ? entry.telemetryState
            : next;
      entry = {
        ...entry,
        telemetryState,
        ...(event.subagentType === undefined ? {} : { name: clip(event.subagentType, 128) }),
        ...(event.description === undefined ? {} : { description: clip(event.description, 512) }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
        ...(event.toolUses === undefined ? {} : { steps: event.toolUses }),
        ...(event.lastToolName === undefined
          ? {}
          : { lastToolName: clip(event.lastToolName, 128) }),
      };
    }
    if (event.kind === "subagentActivity") {
      const next =
        event.activity === "completed"
          ? "completed"
          : event.activity === "interrupted"
            ? "interrupted"
            : "running";
      if (
        event.activity === "interacted" ||
        entry.telemetryState === undefined ||
        entry.telemetryState === "running"
      )
        entry = { ...entry, telemetryState: next };
      entry = { ...entry, name: clip(event.agentPath || "subagent", 128) };
    }
    if (event.kind === "subagentTurnDone")
      entry = {
        ...entry,
        telemetryState: event.isError ? "failed" : "completed",
        ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
      };
    const state =
      entry.resultState === "failed" || entry.telemetryState === "failed"
        ? "failed"
        : (entry.telemetryState ?? entry.resultState ?? "running");
    entries.set(key, { ...entry, state });
    changed = true;
  }
  if (!changed) return previous;
  return {
    entries: [...entries.values()],
    truncated,
    ...(openBatchKey === undefined ? {} : { openBatchKey }),
    ...(counted.size === 0 ? {} : { countedNestedToolIds: [...counted] }),
  };
}

/** Clients that predate the retained detail reject unknown keys, so serve them the closed legacy shape. */
export function legacyAgentSubagentLifecycle(lifecycle: AgentSubagentLifecycle): AgentSubagentLifecycle {
  const entries = lifecycle.entries
    .filter((entry) => entry.parentToolId === undefined)
    .map(({ taskTitle: _title, batchKey: _batch, nestedCount: _nested, parentToolId: _parent, ...legacy }) => legacy);
  return { entries, truncated: lifecycle.truncated || entries.length !== lifecycle.entries.length };
}

function mergeAliases(
  first: AgentSubagentLifecycleEntry,
  second: AgentSubagentLifecycleEntry,
): AgentSubagentLifecycleEntry {
  const terminal = (
    a: AgentSubagentLifecycleState | undefined,
    b: AgentSubagentLifecycleState | undefined,
  ): AgentSubagentLifecycleState | undefined =>
    a === "failed" || b === "failed"
      ? "failed"
      : a === "interrupted" || b === "interrupted"
        ? "interrupted"
        : a === "completed" || b === "completed"
          ? "completed"
          : (a ?? b);
  const telemetryState = terminal(first.telemetryState, second.telemetryState);
  const resultState =
    first.resultState === "failed" || second.resultState === "failed"
      ? "failed"
      : (first.resultState ?? second.resultState);
  const { parentToolId: firstParent, ...firstFields } = first;
  const { parentToolId: secondParent, ...secondFields } = second;
  const parentToolId = firstParent === secondParent ? firstParent : undefined;
  return {
    ...secondFields,
    ...firstFields,
    id: first.id,
    description: first.description || second.description,
    ...(telemetryState === undefined ? {} : { telemetryState }),
    ...(resultState === undefined ? {} : { resultState }),
    ...(parentToolId === undefined ? {} : { parentToolId }),
  };
}

/** Read leniently: an unknown or invalid record is dropped, never allowed to fail a whole task. */
export function readAgentSubagentLifecycle(value: unknown): AgentSubagentLifecycle | undefined {
  try {
    return parseAgentSubagentLifecycle(value);
  } catch {
    return undefined;
  }
}

/** Strict optional persistence boundary; old records omit this field. */
export function parseAgentSubagentLifecycle(value: unknown): AgentSubagentLifecycle | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new TypeError("Invalid retained subagent lifecycle metadata.");
  };
  const object = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return fail();
    return item as Record<string, unknown>;
  };
  const text = (item: unknown, max: number): string => {
    if (typeof item !== "string" || encoder.encode(item).length > max) return fail();
    return item;
  };
  const presentText = (item: unknown, max: number): string => {
    const value = text(item, max);
    if (value === "") return fail();
    return value;
  };
  const countedIds = (item: unknown): ReadonlyArray<string> => {
    if (!Array.isArray(item) || item.length === 0 || item.length > MAX_SUBAGENT_COUNTED_NESTED_IDS) return fail();
    const ids = item.map((id) => presentText(id, 256));
    if (new Set(ids).size !== ids.length) return fail();
    return ids;
  };
  const state = (item: unknown): AgentSubagentLifecycleState => {
    if (item !== "running" && item !== "completed" && item !== "failed" && item !== "interrupted")
      return fail();
    return item;
  };
  const rootFields = ["entries", "truncated", "openBatchKey", "countedNestedToolIds"];
  const record = object(value);
  if (
    Object.keys(record).some((key) => !rootFields.includes(key)) ||
    typeof record.truncated !== "boolean" ||
    !Array.isArray(record.entries) ||
    record.entries.length > MAX_RETAINED_SUBAGENTS
  )
    return fail();
  const seen = new Set<string>();
  const aliases = new Set<string>();
  const entries = record.entries.map((raw): AgentSubagentLifecycleEntry => {
    const entry = object(raw);
    const fields = [
      "id",
      "toolId",
      "taskId",
      "agentThreadId",
      "name",
      "description",
      "state",
      "telemetryState",
      "resultState",
      "durationMs",
      "totalTokens",
      "steps",
      "lastToolName",
      "taskTitle",
      "batchKey",
      "nestedCount",
      "parentToolId",
    ];
    if (Object.keys(entry).some((key) => !fields.includes(key))) return fail();
    const id = text(entry.id, 272);
    if (!id || seen.has(id)) return fail();
    seen.add(id);
    const identity: { toolId?: string; taskId?: string; agentThreadId?: string } = {};
    for (const key of ["toolId", "taskId", "agentThreadId"] as const) {
      if (entry[key] === undefined) continue;
      const value = text(entry[key], 256);
      const alias = `${key}:${value}`;
      if (!value || aliases.has(alias)) return fail();
      aliases.add(alias);
      identity[key] = value;
    }
    if (Object.keys(identity).length === 0) return fail();
    const metrics: { durationMs?: number; totalTokens?: number; steps?: number } = {};
    for (const key of ["durationMs", "totalTokens", "steps"] as const) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== "number" || !Number.isSafeInteger(entry[key]) || entry[key] < 0)
        return fail();
      metrics[key] = entry[key];
    }
    const nestedCount = entry.nestedCount;
    if (
      nestedCount !== undefined &&
      (typeof nestedCount !== "number" || !Number.isSafeInteger(nestedCount) || nestedCount < 1 || nestedCount > MAX_SUBAGENT_NESTED_COUNT)
    )
      return fail();
    const telemetryState =
      entry.telemetryState === undefined ? undefined : state(entry.telemetryState);
    const resultState = entry.resultState === undefined ? undefined : state(entry.resultState);
    if (resultState === "running" || resultState === "interrupted") return fail();
    const expected =
      resultState === "failed" || telemetryState === "failed"
        ? "failed"
        : (telemetryState ?? resultState ?? "running");
    if (state(entry.state) !== expected) return fail();
    return {
      id,
      ...identity,
      name: text(entry.name, 128),
      description: text(entry.description, 512),
      state: expected,
      ...(telemetryState === undefined ? {} : { telemetryState }),
      ...(resultState === undefined ? {} : { resultState }),
      ...metrics,
      ...(entry.lastToolName === undefined ? {} : { lastToolName: text(entry.lastToolName, 128) }),
      ...(entry.taskTitle === undefined ? {} : { taskTitle: presentText(entry.taskTitle, MAX_SUBAGENT_TASK_TITLE_BYTES) }),
      ...(entry.batchKey === undefined ? {} : { batchKey: presentText(entry.batchKey, MAX_SUBAGENT_BATCH_KEY_BYTES) }),
      ...(nestedCount === undefined ? {} : { nestedCount }),
      ...(entry.parentToolId === undefined ? {} : { parentToolId: presentText(entry.parentToolId, MAX_SUBAGENT_PARENT_TOOL_ID_BYTES) }),
    };
  });
  return {
    entries,
    truncated: record.truncated,
    ...(record.openBatchKey === undefined ? {} : { openBatchKey: presentText(record.openBatchKey, MAX_SUBAGENT_BATCH_KEY_BYTES) }),
    ...(record.countedNestedToolIds === undefined ? {} : { countedNestedToolIds: countedIds(record.countedNestedToolIds) }),
  };
}

const MAX_LINE_BYTES = 1024 * 1024;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): string | undefined {
  return typeof value === 'string' && validId(value) && !/\p{Cc}/u.test(value) ? value : undefined;
}
function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function normalizeClaudeStatus(value: unknown): 'starting'|'running'|'completed'|'failed'|'interrupted'|undefined {
  if (value === 'killed' || value === 'cancelled' || value === 'canceled' || value === 'interrupted') return 'interrupted';
  return value === 'starting' || value === 'running' || value === 'completed' || value === 'failed' ? value : undefined;
}
function claudeEvents(value: Record<string, unknown>): AgentTurnEvent[] {
  // Only a nested spawn is meaningful below the top level; other child tools stay invisible.
  const nested = value.parent_tool_use_id == null ? undefined : id(value.parent_tool_use_id);
  if (value.parent_tool_use_id != null && nested === undefined) return [];
  if (value.type === 'result') return nested === undefined ? [{kind:'result'}] : [];
  if (value.type === 'system') {
    if (nested !== undefined) return [];
    if (value.task_type !== undefined && value.task_type !== 'local_agent') return [];
    const rawStatus = value.subtype === 'task_started' ? 'starting' : value.subtype === 'task_progress' ? 'running'
      : value.subtype === 'task_notification' ? value.status : value.subtype === 'task_updated' ? record(value.patch).status : undefined;
    const status = normalizeClaudeStatus(rawStatus);
    const toolId = id(value.tool_use_id), taskId = id(value.task_id);
    if ((!toolId && !taskId) || status === undefined) return [];
    const usage = record(value.usage);
    return [{kind:'subagent',status,toolId,taskId,subagentType:optionalText(value.subagent_type),description:optionalText(value.description),
      durationMs:metric(usage.duration_ms),totalTokens:metric(usage.total_tokens),toolUses:metric(usage.tool_uses),lastToolName:optionalText(value.last_tool_name)}];
  }
  const content = record(value.message).content;
  if (!Array.isArray(content) || (value.type !== 'assistant' && value.type !== 'user')) return [];
  const events: AgentTurnEvent[] = [];
  let results = 0;
  for (const raw of content) {
    const block = record(raw);
    if (value.type === 'assistant' && block.type === 'tool_use' && id(block.id) && typeof block.name === 'string' && spawn(block.name)) {
      const input = record(block.input);
      events.push({kind:'toolCall',toolId:id(block.id)!,name:block.name,inputSummary:'',description:optionalText(input.description) ?? optionalText(input.prompt),
        ...(nested === undefined ? {} : {parentToolId:nested})});
    }
    if (nested !== undefined) continue;
    if (value.type === 'assistant' && block.type === 'text' && optionalText(block.text))
      events.push({kind:'assistantText',text:block.text as string});
    if (value.type === 'user' && block.type === 'tool_result' && id(block.tool_use_id)) {
      results += 1;
      events.push({kind:'toolResult',toolId:id(block.tool_use_id)!,isError:block.is_error === true});
    }
  }
  if (nested !== undefined) return events;
  // A user turn that answers no tool closes any open spawn batch.
  if (value.type === 'user' && results === 0) events.push({kind:'userMessage'});
  const result = record(value.tool_use_result);
  const status = normalizeClaudeStatus(result.status);
  if (id(result.agentId) && typeof result.agentType === 'string' && status !== undefined) {
    const owner = events.length === 1 ? events[0] : undefined;
    events.push({kind:'subagent',taskId:id(result.agentId),toolId:owner?.kind === 'toolResult' ? owner.toolId : undefined,status,subagentType:result.agentType,
      durationMs:metric(result.totalDurationMs),totalTokens:metric(result.totalTokens),toolUses:metric(result.totalToolUseCount)});
  }
  return events;
}
function codexEvents(value: Record<string, unknown>): AgentTurnEvent[] {
  if (value.v === 1) {
    const agentThreadId = id(value.agentThreadId);
    if (value.t === 'subagent' && agentThreadId && (value.kind === 'started' || value.kind === 'interacted' || value.kind === 'interrupted' || value.kind === 'completed'))
      return [{kind:'subagentActivity',agentThreadId,agentPath:optionalText(value.agentPath) ?? '',activity:value.kind}];
    if (value.t === 'subagentTurnCompleted' && agentThreadId && typeof value.isError === 'boolean')
      return [{kind:'subagentTurnDone',agentThreadId,isError:value.isError,durationMs:metric(value.durationMs) ?? null}];
  }
  if (value.type !== 'item.started' && value.type !== 'item.completed') return [];
  const item = record(value.item);
  if (item.type !== 'collab_agent_tool_call' && item.type !== 'collab_tool_call' && item.type !== 'collabAgentToolCall') return [];
  const receivers = item.receiver_thread_ids ?? item.receiverThreadIds;
  if (!Array.isArray(receivers)) return [];
  const states = record(item.agents_states ?? item.agentsStates);
  return receivers.slice(0, MAX_RETAINED_SUBAGENTS + 1).flatMap((receiver): AgentTurnEvent[] => {
    const agentThreadId = id(receiver);
    if (!agentThreadId) return [];
    const status = record(states[agentThreadId]).status;
    if (status === 'completed' || status === 'errored') return [{kind:'subagentTurnDone',agentThreadId,isError:status === 'errored',durationMs:null}];
    const activity = status === 'shutdown' ? 'interrupted' : (item.tool === 'send_input' || item.tool === 'sendInput') ? 'interacted' : 'started';
    return [{kind:'subagentActivity',agentThreadId,agentPath:'',activity}];
  });
}

/** Bounded streaming metadata collector. Feed stdout before its display window is evicted. */
export class SubagentLifecycleCollector {
  private pending = '';
  private bytes = 0;
  private dropping = false;
  private snapshot: AgentSubagentLifecycle | undefined;
  private readonly excludedTaskAliases = new Set<string>();
  private exclusionsFull = false;
  constructor(private readonly provider: 'codex' | 'claude') {}
  current(): AgentSubagentLifecycle | undefined { return this.snapshot; }
  feed(chunk: string): AgentSubagentLifecycle | undefined {
    const before = this.snapshot;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      if (!this.dropping) {
        this.bytes += encoder.encode(part).length;
        if (this.bytes > MAX_LINE_BYTES) {
          this.pending = ''; this.dropping = true; this.markTruncated();
        } else this.pending += part;
      }
      if (newline < 0) break;
      if (!this.dropping) this.line(this.pending);
      this.pending = ''; this.bytes = 0; this.dropping = false;
      start = newline + 1;
    }
    return this.snapshot !== before ? this.snapshot : undefined;
  }
  finish(): AgentSubagentLifecycle | undefined {
    const before = this.snapshot;
    if (this.pending && !this.dropping) this.line(this.pending);
    this.pending = ''; this.bytes = 0; this.dropping = false;
    return this.snapshot !== before ? this.snapshot : undefined;
  }
  private markTruncated(): void {
    if (!this.snapshot?.truncated) this.snapshot = {...this.snapshot,entries:this.snapshot?.entries ?? [],truncated:true};
  }
  private excludeNonAgent(value: Record<string, unknown>): boolean {
    if (value.type !== 'system' || value.parent_tool_use_id != null) return false;
    const taskId = id(value.task_id), toolId = id(value.tool_use_id);
    const aliases = [...(taskId ? [`task:${taskId}`] : []), ...(toolId ? [`tool:${toolId}`] : [])];
    const excluded = value.task_type !== undefined && value.task_type !== 'local_agent';
    if (excluded) {
      for (const alias of aliases) {
        if (this.excludedTaskAliases.has(alias)) continue;
        if (this.excludedTaskAliases.size >= 512) { this.exclusionsFull = true; this.markTruncated(); }
        else this.excludedTaskAliases.add(alias);
      }
      return true;
    }
    if (aliases.some(alias => this.excludedTaskAliases.has(alias))) return true;
    // After exhaustion, ambiguous events cannot invent an agent for an untracked shell task.
    return this.exclusionsFull && value.task_type === undefined && !this.snapshot?.entries.some(entry =>
      (taskId !== undefined && entry.taskId === taskId) || (toolId !== undefined && entry.toolId === toolId));
  }
  private line(line: string): void {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try { value = record(JSON.parse(line) as unknown); } catch { this.markTruncated(); return; }
    if (this.provider === 'claude' && this.excludeNonAgent(value)) return;
    const next = retainAgentSubagentLifecycle(this.snapshot, this.provider === 'claude' ? claudeEvents(value) : codexEvents(value));
    if (next !== this.snapshot && JSON.stringify(next) !== JSON.stringify(this.snapshot)) this.snapshot = next;
  }
}
