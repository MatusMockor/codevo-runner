import type { AgentTurnEvent } from '../src/domain/subagent-lifecycle.js';

type Random = (bound: number) => number;

/** Deterministic per-seed generator: a failing stream is replayable from its seed alone. */
export function seededRandom(seed: number): Random {
  let state = (seed * 2_654_435_761) >>> 0;
  return bound => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state % bound;
  };
}

function pick<T>(next: Random, values: readonly T[]): T {
  return values[next(values.length)]!;
}

function telemetry(next: Random): Partial<Extract<AgentTurnEvent, { kind: 'subagent' }>> {
  return {
    ...(next(3) === 0 ? { subagentType: `type${next(2)}` } : {}),
    ...(next(3) === 0 ? { description: `desc${next(2)}` } : {}),
    ...(next(2) === 0 ? { durationMs: next(1_000) } : {}),
    ...(next(2) === 0 ? { totalTokens: next(1_000) } : {}),
    ...(next(2) === 0 ? { toolUses: next(9) } : {}),
    ...(next(2) === 0 ? { lastToolName: `Tool${next(3)}` } : {}),
  };
}

const TOOL_IDS = ['tool_a', 'tool_b', 'tool_c'] as const;
const TASK_IDS = ['task_a', 'task_b', 'task_c'] as const;
const THREAD_IDS = ['thread_a', 'thread_b'] as const;
const SPAWN_NAMES = ['Task', 'Agent', 'SpawnAgent', 'spawn_agent'] as const;

/** Mixed provider chatter: aliases, replays, terminal frames and non-spawn tools. */
export function agentTurnStream(seed: number, length: number): AgentTurnEvent[] {
  const next = seededRandom(seed);
  const toolId = (): string => pick(next, TOOL_IDS);
  const makers: ReadonlyArray<() => AgentTurnEvent> = [
    () => ({ kind: 'toolCall', toolId: toolId(), name: pick(next, SPAWN_NAMES), inputSummary: `in${next(3)}`, description: `Work ${next(3)}` }),
    () => ({ kind: 'toolCall', toolId: toolId(), name: pick(next, ['Read', 'Bash', 'Edit'] as const), inputSummary: `in${next(3)}` }),
    () => ({ kind: 'toolResult', toolId: toolId(), isError: next(4) === 0 }),
    () => ({ kind: 'subagent', status: pick(next, ['starting', 'running', 'completed', 'failed', 'interrupted'] as const), taskId: pick(next, TASK_IDS), ...telemetry(next) }),
    () => ({ kind: 'subagent', status: pick(next, ['starting', 'running', 'completed'] as const), taskId: pick(next, TASK_IDS), toolId: toolId(), ...telemetry(next) }),
    () => ({ kind: 'subagentActivity', agentThreadId: pick(next, THREAD_IDS), agentPath: `p${next(2)}`, activity: pick(next, ['started', 'interacted', 'interrupted', 'completed'] as const) }),
    () => ({ kind: 'subagentTurnDone', agentThreadId: pick(next, THREAD_IDS), durationMs: next(3) === 0 ? null : next(99), isError: next(3) === 0 }),
    () => ({ kind: 'assistantText', text: `w${next(3)}` }),
    () => ({ kind: 'userMessage' }),
    () => ({ kind: 'result' }),
  ];
  return Array.from({ length }, () => pick(next, makers)());
}

const NESTED_ROOT_TOOL_IDS = ['tool_root_a', 'tool_root_b'] as const;
const NESTED_CHILD_TOOL_IDS = ['tool_child_a', 'tool_child_b', 'tool_child_c'] as const;

/** Nested spawn fan-out where child tool ids collide with task-keyed identities already retained. */
export function nestedSpawnAgentTurnStream(seed: number, length: number): AgentTurnEvent[] {
  const next = seededRandom(seed);
  const rootId = (): string => pick(next, NESTED_ROOT_TOOL_IDS);
  const childId = (): string => pick(next, NESTED_CHILD_TOOL_IDS);
  const anyId = (): string => (next(4) === 0 ? rootId() : childId());
  const taskId = (): string => pick(next, TASK_IDS);
  const makers: ReadonlyArray<() => AgentTurnEvent> = [
    () => ({ kind: 'toolCall', toolId: rootId(), name: pick(next, ['Task', 'Agent', 'SpawnAgent'] as const), inputSummary: `top${next(3)}`, description: `Top level work ${next(3)}` }),
    () => ({ kind: 'toolCall', toolId: anyId(), name: pick(next, ['Task', 'Agent'] as const), inputSummary: `nested${next(3)}`, description: `Nested work ${next(3)}`, parentToolId: anyId() }),
    () => ({ kind: 'toolCall', toolId: childId(), name: pick(next, ['Task', 'Agent'] as const), inputSummary: `nested${next(3)}`, description: `Nested work ${next(3)}`, parentToolId: rootId() }),
    () => ({ kind: 'toolCall', toolId: childId(), name: 'Read', inputSummary: `file${next(3)}`, parentToolId: anyId() }),
    () => ({ kind: 'subagent', status: 'running', taskId: taskId(), ...telemetry(next) }),
    () => ({ kind: 'subagent', status: 'starting', taskId: taskId(), description: `t${next(3)}` }),
    () => ({ kind: 'subagent', status: pick(next, ['starting', 'running', 'completed', 'failed'] as const), taskId: taskId(), toolId: childId(), ...telemetry(next) }),
    () => ({ kind: 'toolResult', toolId: anyId(), isError: next(4) === 0 }),
    () => ({ kind: 'subagentActivity', agentThreadId: pick(next, THREAD_IDS), agentPath: `p${next(2)}`, activity: pick(next, ['started', 'interacted', 'interrupted', 'completed'] as const) }),
    () => ({ kind: 'subagentTurnDone', agentThreadId: pick(next, THREAD_IDS), durationMs: next(99), isError: next(3) === 0 }),
    () => ({ kind: 'assistantText', text: `w${next(3)}` }),
    () => ({ kind: 'userMessage' }),
  ];
  return Array.from({ length }, () => pick(next, makers)());
}
