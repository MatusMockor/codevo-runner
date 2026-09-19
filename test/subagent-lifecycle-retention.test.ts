import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import {
  MAX_RETAINED_SUBAGENTS,
  MAX_SUBAGENT_BATCH_KEY_BYTES,
  MAX_SUBAGENT_COUNTED_NESTED_IDS,
  MAX_SUBAGENT_NESTED_COUNT,
  MAX_SUBAGENT_PARENT_TOOL_ID_BYTES,
  MAX_SUBAGENT_TASK_TITLE_BYTES,
  SUBAGENT_LIFECYCLE_RETENTION,
  SubagentLifecycleCollector,
  legacyAgentSubagentLifecycle,
  parseAgentSubagentLifecycle,
  readAgentSubagentLifecycle,
  retainAgentSubagentLifecycle,
  type AgentSubagentLifecycle,
  type AgentSubagentLifecycleEntry,
  type AgentTurnEvent,
} from '../src/domain/subagent-lifecycle.js';
import { agentTurnStream, nestedSpawnAgentTurnStream } from './agent-turn-event-streams.js';
import { clientCapabilities } from '../src/transport/http.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { TaskService } from '../src/application/task-service.js';
import { createRunnerApplication } from '../src/server.js';
import { RunnerError, type EventPage } from '../src/domain/contracts.js';
import type { TaskRepository } from '../src/application/ports.js';
import type { RunnerServices } from '../src/transport/services.js';

type WireFixture = Readonly<{
  schemaVersion: number;
  limits: Readonly<{ entries: number; taskTitleBytes: number; batchKeyBytes: number; parentToolIdBytes: number; nestedCount: number; countedNestedToolIds: number }>;
  valid: Readonly<{ legacy: AgentSubagentLifecycle; retained: AgentSubagentLifecycle }>;
  invalidEntryPatches: readonly Readonly<Record<string, unknown>>[];
  invalidRootPatches: readonly Readonly<Record<string, unknown>>[];
}>;
const wire = JSON.parse(readFileSync(new URL('../../test/fixtures/agent-subagent-lifecycle-wire.json', import.meta.url), 'utf8')) as WireFixture;

const line = (value: unknown) => JSON.stringify(value) + '\n';
const spawned = (toolId: string, description: string, parentToolId?: string) => line({
  type: 'assistant', ...(parentToolId === undefined ? {} : { parent_tool_use_id: parentToolId }),
  message: { content: [{ type: 'tool_use', id: toolId, name: 'Task', input: { description } }] },
});
const started = (toolId: string, taskId: string) =>
  line({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: taskId, tool_use_id: toolId });
const progressed = (taskId: string, description: string) => line({
  type: 'system', subtype: 'task_progress', task_type: 'local_agent', task_id: taskId,
  subagent_type: 'general-purpose', description, last_tool_name: 'Read',
  usage: { total_tokens: 512, duration_ms: 2961, tool_uses: 2 },
});
const said = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const finished = (toolId: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId }] } });
const keys = (lifecycle: AgentSubagentLifecycle | undefined) => (lifecycle?.entries ?? []).map(entry => entry.batchKey);

const spawnEvent = (toolId: string, description: string, parentToolId?: string): AgentTurnEvent => ({
  kind: 'toolCall', toolId, name: 'Agent', inputSummary: description, description,
  ...(parentToolId === undefined ? {} : { parentToolId }),
});
const launchedEvent = (toolId: string): AgentTurnEvent => ({ kind: 'toolResult', toolId, isError: false });
const retainInChunks = (chunks: ReadonlyArray<ReadonlyArray<AgentTurnEvent>>) => {
  let lifecycle: AgentSubagentLifecycle | undefined;
  for (const chunk of chunks) lifecycle = retainAgentSubagentLifecycle(lifecycle, chunk);
  return lifecycle;
};
const roundTrip = (lifecycle: AgentSubagentLifecycle | undefined): unknown =>
  lifecycle === undefined ? undefined : JSON.parse(JSON.stringify(lifecycle));

test('the spawn task title outlives six hundred progress ticks that keep rewriting the description', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('tool-1', '  Fix subagent   view findings  '));
  collector.feed(started('tool-1', 'task-1'));
  for (let tick = 0; tick < 600; tick++) collector.feed(progressed('task-1', `Running step ${tick}`));
  const snapshot = collector.current()!;
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]?.taskTitle, 'Fix subagent view findings');
  assert.equal(snapshot.entries[0]?.description, 'Running step 599');
  assert.equal(snapshot.entries[0]?.name, 'general-purpose');
  assert.deepEqual(parseAgentSubagentLifecycle(snapshot), snapshot);
});

test('a title arrives from the first starting frame when the spawn call was never observed', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(line({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'task-1', description: 'Review slice fixes' }));
  collector.feed(progressed('task-1', 'Reading a file'));
  collector.feed(line({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'task-1', description: 'Later restart text' }));
  assert.equal(collector.current()?.entries[0]?.taskTitle, 'Review slice fixes');
});

test('the retained title is bounded on code point boundaries within the shared byte limit', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('tool-1', '\u{1F600}'.repeat(400)));
  const title = collector.current()?.entries[0]?.taskTitle ?? '';
  assert.equal([...title].length, 120);
  assert.ok(Buffer.byteLength(title) <= wire.limits.taskTitleBytes);
  assert.deepEqual(parseAgentSubagentLifecycle(collector.current()), collector.current());
});

test('parallel spawns share one frozen batch key while sequential spawns start their own', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(line({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'a', name: 'Task', input: { description: 'Stream A' } },
    { type: 'tool_use', id: 'b', name: 'Task', input: { description: 'Stream B' } },
  ] } }));
  assert.deepEqual(keys(collector.current()), ['spawn:a', 'spawn:a']);
  assert.equal(collector.current()?.openBatchKey, 'spawn:a');
  collector.feed(finished('a'));
  collector.feed(finished('b'));
  assert.equal(collector.current()?.openBatchKey, undefined);
  collector.feed(spawned('c', 'Stream C'));
  collector.feed(said('Waiting for all three.'));
  collector.feed(spawned('d', 'Stream D'));
  assert.deepEqual(keys(collector.current()), ['spawn:a', 'spawn:a', 'spawn:c', 'spawn:d']);
});

test('a re-observed spawn never reopens or rewrites its batch', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('a', 'First'));
  collector.feed(finished('a'));
  collector.feed(line({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'a', name: 'Task', input: { description: 'First' } },
    { type: 'tool_use', id: 'c', name: 'Task', input: { description: 'Third' } },
  ] } }));
  assert.deepEqual(keys(collector.current()), ['spawn:a', 'spawn:c']);
  assert.equal(collector.current()?.openBatchKey, 'spawn:c');
});

test('an entry that never saw its spawn call keeps no batch key', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(progressed('task-1', 'Reading'));
  assert.equal(collector.current()?.entries[0]?.batchKey, undefined);
});

test('nested spawns count on the top level ancestor and stay out of the top level', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('parent', 'Lead work'));
  collector.feed(spawned('child', 'Child work', 'parent'));
  collector.feed(spawned('grandchild', 'Deep work', 'child'));
  collector.feed(spawned('child', 'Child work', 'parent'));
  const entries = collector.current()?.entries ?? [];
  assert.equal(entries.find(entry => entry.id === 'tool:parent')?.nestedCount, 2);
  assert.equal(entries.filter(entry => entry.parentToolId === undefined).length, 1);
  assert.deepEqual(entries.find(entry => entry.id === 'tool:child'), {
    id: 'tool:child', toolId: 'child', parentToolId: 'parent', name: 'Task',
    description: 'Child work', state: 'running', taskTitle: 'Child work',
  } satisfies AgentSubagentLifecycleEntry);
  assert.equal(collector.current()?.truncated, false);
  assert.deepEqual(parseAgentSubagentLifecycle(collector.current()), collector.current());
});

test('a nested spawn replayed five times counts once even at the retained entry cap', () => {
  const collector = new SubagentLifecycleCollector('claude');
  for (let index = 0; index < MAX_RETAINED_SUBAGENTS; index++) collector.feed(spawned(`t${index}`, 'Work'));
  for (let replay = 0; replay < 5; replay++) collector.feed(spawned('child', 'Child work', 't0'));
  const snapshot = collector.current()!;
  assert.equal(snapshot.entries.length, MAX_RETAINED_SUBAGENTS);
  assert.equal(snapshot.entries[0]?.nestedCount, 1);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.countedNestedToolIds, ['child']);
  assert.deepEqual(parseAgentSubagentLifecycle(snapshot), snapshot);
});

test('remembered nested identities and the nested count stay bounded', () => {
  const collector = new SubagentLifecycleCollector('claude');
  for (let index = 0; index < MAX_RETAINED_SUBAGENTS; index++) collector.feed(spawned(`t${index}`, 'Work'));
  for (let index = 0; index < MAX_SUBAGENT_COUNTED_NESTED_IDS + 4; index++) collector.feed(spawned(`child-${index}`, 'Child', 't0'));
  assert.equal(collector.current()?.countedNestedToolIds?.length, MAX_SUBAGENT_COUNTED_NESTED_IDS);
  assert.equal(collector.current()?.entries[0]?.nestedCount, MAX_SUBAGENT_COUNTED_NESTED_IDS + 4);
  assert.deepEqual(parseAgentSubagentLifecycle(collector.current()), collector.current());

  const saturated = new SubagentLifecycleCollector('claude');
  saturated.feed(spawned('parent', 'Lead'));
  for (let index = 0; index < MAX_SUBAGENT_NESTED_COUNT + 5; index++) saturated.feed(spawned(`child-${index}`, 'Child', 'parent'));
  assert.equal(saturated.current()?.entries[0]?.nestedCount, MAX_SUBAGENT_NESTED_COUNT);
});

test('a nested spawn without a retained ancestor is reported as truncated, never as a root agent', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('child', 'Child work', 'missing'));
  assert.deepEqual(collector.current(), { entries: [], truncated: true });
});

test('a nested spawn reusing a tool identity already tracked at the top level cannot poison persistence', () => {
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('P', 'Lead work'));
  collector.feed(line({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'T' }));
  collector.feed(line({ type: 'system', subtype: 'task_progress', task_type: 'local_agent', task_id: 'T', tool_use_id: 'X' }));
  collector.feed(spawned('X', 'Child work', 'P'));
  const snapshot = collector.current()!;
  const toolIds = snapshot.entries.flatMap(entry => (entry.toolId === undefined ? [] : [entry.toolId]));
  assert.equal(new Set(toolIds).size, toolIds.length);
  assert.deepEqual(parseAgentSubagentLifecycle(snapshot), snapshot);
});

test('a nested spawn attaches to the entry that already owns its tool id', () => {
  const lifecycle = retainInChunks([
    [spawnEvent('P', 'Lead work')],
    [{ kind: 'subagent', status: 'starting', taskId: 'T', description: 'Task telemetry' }],
    [{ kind: 'subagent', status: 'running', taskId: 'T', toolId: 'X' }],
    [spawnEvent('X', 'Nested work', 'P')],
  ]);
  const entries = lifecycle?.entries ?? [];
  assert.equal(entries.filter(entry => entry.toolId === 'X').length, 1);
  assert.equal(entries.find(entry => entry.toolId === 'X')?.taskId, 'T');
  assert.equal(entries.find(entry => entry.toolId === 'X')?.parentToolId, 'P');
  assert.equal(entries.find(entry => entry.toolId === 'P')?.nestedCount, 1);
  assert.deepEqual(parseAgentSubagentLifecycle(roundTrip(lifecycle)), lifecycle);
});

test('an adopted nested spawn counts once when the stream redelivers it', () => {
  const lifecycle = retainInChunks([
    [spawnEvent('P', 'Lead work')],
    [{ kind: 'subagent', status: 'running', taskId: 'T', toolId: 'X' }],
    [spawnEvent('X', 'Nested work', 'P')],
    [spawnEvent('X', 'Nested work', 'P')],
  ]);
  assert.equal(lifecycle?.entries.find(entry => entry.toolId === 'P')?.nestedCount, 1);
  assert.deepEqual(parseAgentSubagentLifecycle(roundTrip(lifecycle)), lifecycle);
});

test('an entry never nests under itself or its own descendant', () => {
  const lifecycle = retainInChunks([
    [spawnEvent('root', 'Lead')],
    [spawnEvent('child', 'Child', 'root')],
    [spawnEvent('root', 'Cycle', 'child')],
    [spawnEvent('root', 'Self', 'root')],
  ]);
  const entries = lifecycle?.entries ?? [];
  assert.equal(entries.find(entry => entry.toolId === 'root')?.parentToolId, undefined);
  assert.equal(entries.find(entry => entry.toolId === 'root')?.nestedCount, 1);
  assert.deepEqual(parseAgentSubagentLifecycle(roundTrip(lifecycle)), lifecycle);
});

test('a merged alias stays nested only when both sides shared the same parent', () => {
  const nested = retainInChunks([
    [spawnEvent('root', 'Lead')],
    [{ kind: 'subagent', status: 'running', taskId: 'solo' }],
    [{ kind: 'subagent', status: 'running', taskId: 'solo', toolId: 'n1' }],
    [spawnEvent('n1', 'Nested one', 'root'), spawnEvent('n2', 'Nested two', 'root')],
    [{ kind: 'subagent', status: 'running', taskId: 'solo', toolId: 'n2' }],
  ]);
  assert.equal(nested?.entries.filter(entry => entry.toolId === 'n2').length, 1);
  assert.equal(nested?.entries.find(entry => entry.taskId === 'solo')?.parentToolId, 'root');

  const promoted = retainInChunks([
    [{ kind: 'subagent', status: 'running', taskId: 'solo' }],
    [spawnEvent('lead', 'Lead')],
    [spawnEvent('alias', 'Nested', 'lead')],
    [{ kind: 'subagent', status: 'running', taskId: 'solo', toolId: 'alias' }],
  ]);
  assert.equal(promoted?.entries.filter(entry => entry.toolId === 'alias').length, 1);
  assert.equal(promoted?.entries.find(entry => entry.taskId === 'solo')?.parentToolId, undefined);
  assert.deepEqual(parseAgentSubagentLifecycle(roundTrip(promoted)), promoted);
});

test(`a replayed nested spawn recounts once its identity leaves the ${MAX_SUBAGENT_COUNTED_NESTED_IDS}-identity memory`, () => {
  const roots = Array.from({ length: MAX_RETAINED_SUBAGENTS }, (_, index) => spawnEvent(`t${index}`, 'Work'));
  const distinct = MAX_SUBAGENT_COUNTED_NESTED_IDS + 1;
  const nested = Array.from({ length: distinct }, (_, index) => spawnEvent(`child-${index}`, 'Child', 't0'));
  const filled = retainInChunks([roots, nested]);
  assert.equal(filled?.countedNestedToolIds?.length, MAX_SUBAGENT_COUNTED_NESTED_IDS);
  assert.equal(filled?.countedNestedToolIds?.includes('child-0'), false);
  assert.equal(filled?.entries[0]?.nestedCount, distinct);

  const remembered = retainAgentSubagentLifecycle(filled, [spawnEvent(`child-${distinct - 1}`, 'Child', 't0')]);
  assert.equal(remembered?.entries[0]?.nestedCount, distinct);
  const forgotten = retainAgentSubagentLifecycle(remembered, [spawnEvent('child-0', 'Child', 't0')]);
  assert.equal(forgotten?.entries[0]?.nestedCount, distinct + 1);
});

test('a re-observed spawn never reopens a batch and leaves the root key unchanged', () => {
  const opened = retainAgentSubagentLifecycle(undefined, [spawnEvent('a', 'First')]);
  assert.equal(opened?.openBatchKey, 'spawn:a');
  const replayed = retainAgentSubagentLifecycle(opened, [spawnEvent('a', 'First')]);
  assert.equal(replayed?.openBatchKey, 'spawn:a');
  assert.equal(replayed?.entries[0]?.batchKey, 'spawn:a');
  const closed = retainAgentSubagentLifecycle(replayed, [{ kind: 'assistantText', text: 'Waiting for the agent.' }]);
  assert.equal(closed?.openBatchKey, undefined);
  const reopened = retainAgentSubagentLifecycle(closed, [spawnEvent('a', 'First'), launchedEvent('a')]);
  assert.equal(reopened?.openBatchKey, undefined);
  assert.equal(reopened?.entries[0]?.batchKey, 'spawn:a');
});

test('every incremental snapshot stays strictly parseable across generated streams', () => {
  for (let seed = 0; seed < 24; seed++)
    for (const events of [nestedSpawnAgentTurnStream(seed, 80), agentTurnStream(seed, 80)]) {
      let lifecycle: AgentSubagentLifecycle | undefined;
      for (const [index, event] of events.entries()) {
        lifecycle = retainAgentSubagentLifecycle(lifecycle, [event]);
        const label = `seed ${seed} event ${index} ${event.kind}`;
        assert.deepEqual(parseAgentSubagentLifecycle(roundTrip(lifecycle)), lifecycle, label);
        const ids = (lifecycle?.entries ?? []).map(entry => entry.id);
        assert.equal(new Set(ids).size, ids.length, label);
      }
    }
});

test('the shared wire fixture round-trips and every invalid patch fails closed', () => {
  assert.deepEqual(wire.limits, {
    entries: MAX_RETAINED_SUBAGENTS,
    taskTitleBytes: MAX_SUBAGENT_TASK_TITLE_BYTES,
    batchKeyBytes: MAX_SUBAGENT_BATCH_KEY_BYTES,
    parentToolIdBytes: MAX_SUBAGENT_PARENT_TOOL_ID_BYTES,
    nestedCount: MAX_SUBAGENT_NESTED_COUNT,
    countedNestedToolIds: MAX_SUBAGENT_COUNTED_NESTED_IDS,
  });
  for (const snapshot of [wire.valid.legacy, wire.valid.retained])
    assert.deepEqual(JSON.parse(JSON.stringify(parseAgentSubagentLifecycle(snapshot))), snapshot);
  const [entry, ...rest] = wire.valid.retained.entries;
  for (const patch of wire.invalidEntryPatches)
    assert.throws(() => parseAgentSubagentLifecycle({ ...wire.valid.retained, entries: [{ ...entry, ...patch }, ...rest] }), JSON.stringify(patch));
  for (const patch of wire.invalidRootPatches)
    assert.throws(() => parseAgentSubagentLifecycle({ ...wire.valid.retained, ...patch }), JSON.stringify(patch));
});

test('an unreadable stored lifecycle is dropped instead of failing the whole record', () => {
  assert.equal(readAgentSubagentLifecycle({ entries: [{ id: 'tool:a', toolId: 'a', name: 'Task', description: '', state: 'running', unknownField: true }], truncated: false }), undefined);
  assert.equal(readAgentSubagentLifecycle({ entries: [], truncated: false, openBatchKey: '' }), undefined);
  assert.deepEqual(readAgentSubagentLifecycle(wire.valid.retained), parseAgentSubagentLifecycle(wire.valid.retained));
});

test('the legacy projection removes retained detail and reports the dropped nested agents', () => {
  const retained = parseAgentSubagentLifecycle(wire.valid.retained)!;
  const legacy = legacyAgentSubagentLifecycle(retained);
  const allowed = ['id', 'toolId', 'taskId', 'agentThreadId', 'name', 'description', 'state', 'telemetryState', 'resultState', 'durationMs', 'totalTokens', 'steps', 'lastToolName'];
  assert.deepEqual(Object.keys(legacy).filter(key => key !== 'entries' && key !== 'truncated'), []);
  assert.equal(legacy.entries.length, 1);
  assert.deepEqual(legacy.entries.flatMap(entry => Object.keys(entry)).filter(key => !allowed.includes(key)), []);
  assert.equal(legacy.truncated, true);
  assert.deepEqual(legacyAgentSubagentLifecycle(parseAgentSubagentLifecycle(wire.valid.legacy)!), wire.valid.legacy);
});

test('announced client capabilities are parsed within bounds and default to none', () => {
  assert.equal(clientCapabilities(`${SUBAGENT_LIFECYCLE_RETENTION},somethingElse`).has(SUBAGENT_LIFECYCLE_RETENTION), true);
  assert.equal(clientCapabilities(` ${SUBAGENT_LIFECYCLE_RETENTION} `).has(SUBAGENT_LIFECYCLE_RETENTION), true);
  assert.equal(clientCapabilities(undefined).size, 0);
  // Node joins repeated headers into one string; a list value is malformed and announces nothing.
  assert.equal(clientCapabilities([SUBAGENT_LIFECYCLE_RETENTION]).size, 0);
  assert.equal(clientCapabilities(`somethingElse, ${SUBAGENT_LIFECYCLE_RETENTION}`).has(SUBAGENT_LIFECYCLE_RETENTION), true);
  assert.equal(clientCapabilities(`${SUBAGENT_LIFECYCLE_RETENTION}\n`).size, 0);
  assert.equal(clientCapabilities('x'.repeat(513)).size, 0);
  assert.equal(clientCapabilities(Array.from({ length: 16 }, (_, index) => `c${index}`).join(',')).size, 16);
  // An over-budget header announces nothing rather than a silently truncated subset.
  assert.equal(clientCapabilities([...Array.from({ length: 16 }, (_, index) => `c${index}`), SUBAGENT_LIFECYCLE_RETENTION].join(',')).size, 0);
  assert.equal(clientCapabilities(Array.from({ length: 64 }, (_, index) => `capability${index}`).join(',')).size, 0);
});

async function repository(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-lifecycle-'));
  const identity = randomUUID();
  let store = await openSqliteRepository(directory, identity);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const task = (await store.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'Work' }] })).task;
  await store.queueTask(task.id, 'project');
  await store.claimNextTask();
  return {
    task, get store() { return store; },
    async reopen() { await store.close(); store = await openSqliteRepository(directory, identity); return store; },
    async corrupt(payload: string) {
      await store.close();
      const raw = new DatabaseSync(join(directory, 'runner.sqlite'));
      try { raw.prepare('UPDATE task_subagents SET payload=? WHERE task_id=?').run(payload, task.id); } finally { raw.close(); }
      store = await openSqliteRepository(directory, identity);
      return store;
    },
  };
}

test('retained lifecycle detail survives storage, restart and output eviction', async t => {
  const state = await repository(t);
  const collector = new SubagentLifecycleCollector('claude');
  collector.feed(spawned('tool-1', 'Fix subagent view findings'));
  collector.feed(started('tool-1', 'task-1'));
  collector.feed(spawned('nested', 'Review slice fixes', 'tool-1'));
  for (let tick = 0; tick < 200; tick++) collector.feed(progressed('task-1', `Running step ${tick}`));
  const snapshot = collector.current()!;
  await state.store.setTaskSubagents!(state.task.id, snapshot);
  for (let index = 0; index < 140; index++) await state.store.appendTaskOutput(state.task.id, 'stdout', 'x'.repeat(8191) + '\n');
  const store = await state.reopen();
  const page = await store.listEvents(state.task.id, 0);
  assert.ok(page.outputTruncatedBeforeSequence);
  assert.deepEqual(page.subagentLifecycle, snapshot);
  assert.equal(page.subagentLifecycle?.entries[0]?.taskTitle, 'Fix subagent view findings');
  assert.equal(page.subagentLifecycle?.entries[0]?.nestedCount, 1);
  assert.equal(page.subagentLifecycle?.entries[1]?.parentToolId, 'tool-1');
});

test('a stored lifecycle written by an unknown version never makes the task unreadable', async t => {
  const state = await repository(t);
  await state.store.setTaskSubagents!(state.task.id, { entries: [], truncated: false });
  await state.store.appendTaskOutput(state.task.id, 'stdout', 'hello\n');
  const store = await state.corrupt(JSON.stringify({ entries: [{ id: 'tool:a', toolId: 'a', name: 'Task', description: '', state: 'running', futureField: 1 }], truncated: false }));
  const page = await store.listEvents(state.task.id, 0);
  assert.equal(page.subagentLifecycle, undefined);
  assert.ok(page.items.some(event => event.type === 'task.output'));
});

async function server(t: TestContext, page: EventPage) {
  const token = 'lifecycle-test-token-123456789012345678901234567890';
  const unavailable = () => Promise.reject(new RunnerError('not_found'));
  const tasks: TaskRepository = { createTask: unavailable, getTask: unavailable, listTasks: unavailable, cancelTask: unavailable, listEvents: () => Promise.resolve(page) };
  const services: RunnerServices = {
    tasks: new TaskService(tasks),
    attachments: { metadata: unavailable, upload: unavailable, read: unavailable, close: () => Promise.resolve() },
    close: () => Promise.resolve(),
  };
  const app = await createRunnerApplication(
    { protocolVersion: 1, runnerId: randomUUID(), name: 'Lifecycle capability test', capabilities: { taskExecution: false, eventReplay: true } },
    header => header === `Bearer ${token}`, services);
  t.after(async () => { await app.close(); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return {
    descriptor: async () => (await (await fetch(`${url}/v1/runner`, { headers: { authorization: `Bearer ${token}` } })).json()) as { capabilities: Record<string, boolean> },
    events: async (capabilities?: string) => (await (await fetch(`${url}/v1/tasks/${randomUUID()}/events?after=0`, {
      headers: { authorization: `Bearer ${token}`, ...(capabilities === undefined ? {} : { 'x-codevo-client-capabilities': capabilities }) },
    })).json()) as EventPage,
  };
}

test('retained lifecycle detail is served only to clients that announce support for it', async t => {
  const retained = parseAgentSubagentLifecycle(wire.valid.retained)!;
  const remote = await server(t, { items: [], nextCursor: null, subagentLifecycle: retained });
  assert.equal((await remote.descriptor()).capabilities[SUBAGENT_LIFECYCLE_RETENTION], true);
  assert.deepEqual((await remote.events(SUBAGENT_LIFECYCLE_RETENTION)).subagentLifecycle, retained);
  assert.deepEqual((await remote.events()).subagentLifecycle, legacyAgentSubagentLifecycle(retained));
  assert.deepEqual((await remote.events('someOtherCapability')).subagentLifecycle, legacyAgentSubagentLifecycle(retained));
});
