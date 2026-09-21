import { textAttachmentPrompt } from '../../domain/text-attachment.js';
import { SteeringNotSent } from '../../domain/steering.js';
import { lstat, realpath } from 'node:fs/promises';
import type { ExecutionRequest, ExecutionResult } from '../../domain/execution.js';
import { ARTIFACT_HINT } from '../../domain/artifact-hint.js';
import { isProviderSessionId } from '../../domain/provider-output.js';
import { parseAgentQuestionRequest, parseAgentQuestionResponse } from '../../domain/questions.js';
import { emitInteractiveOutput, runInteractiveProcess, type InteractiveProtocol, type InteractiveSend } from './interactive-process.js';

export interface CodexInteractivePlan {
  readonly executable: string;
  readonly cwd: string;
  readonly cwdIdentity?: Readonly<{ dev: number; ino: number }>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly request: ExecutionRequest;
  readonly prompt: string;
  readonly sandbox: 'workspace-write' | 'external-sandbox';
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_protocol_invalid');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error('provider_owner_invalid');
  return value;
}

/** One app-server process owns exactly one thread and one turn. No approval escalation. */
export function createCodexProtocol(plan: CodexInteractivePlan): InteractiveProtocol {
  let stage: 'initialize' | 'thread' | 'turn' | 'running' | 'done' = 'initialize';
  let threadId: string | undefined;
  let turnId: string | undefined;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  const requestIds = new Set<string>();
  const children = new Map<string, string | undefined>();
  const childTurns = new Set<string>();
  let pendingQuestion: string | undefined;
  let steeringSequence = 3;
  let pendingSteer: { id: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const rejectSteer = () => { if (pendingSteer) { clearTimeout(pendingSteer.timer); pendingSteer.reject(new Error('steering_unavailable')); pendingSteer = undefined; } };
  const dispose = () => { stage = 'done'; rejectSteer(); plan.request.onSteeringReady?.(undefined); };

  const launch = plan.request.task.launch;
  if (launch && launch.provider !== 'codex') throw new Error('provider_mismatch');
  const model = launch && launch.model !== 'default' ? { model: launch.model } : {};
  const mode = launch?.mode;
  const sandbox = mode === 'dangerFullAccess' ? 'danger-full-access' : mode === 'readOnly' ? 'read-only'
    : mode === 'workspaceWrite' || mode === 'auto' ? 'workspace-write'
    : !launch ? (plan.sandbox === 'external-sandbox' ? 'danger-full-access' : 'workspace-write') : undefined;
  const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
    : sandbox === 'workspace-write' ? { type: 'workspaceWrite', networkAccess: false, writableRoots: [plan.cwd] } : undefined;
  const emit = async (event: unknown) => emitInteractiveOutput(plan.request.onOutput, 'stdout', JSON.stringify(event) + '\n');
  const call = (send: InteractiveSend, id: number, method: string, params: unknown) => send({ id, method, params });
  const owner = (params: Record<string, unknown>) => {
    if (!threadId || !turnId || params.threadId !== threadId || params.turnId !== turnId) throw new Error('provider_owner_mismatch');
  };
  return {
    dispose,
    async start(send) {
      await call(send, 1, 'initialize', { clientInfo: { name: 'codevo_runner', title: 'Codevo Runner', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    },
    async receive(frame, send, fail): Promise<ExecutionResult | undefined> {
      if (plan.signal.aborted) return { exitCode: null, error: 'cancelled' };
      if (stage === 'done') throw new Error('provider_protocol_finished');
      if (frame.method === undefined && pendingSteer && pendingSteer.id === frame.id) {
        const pending = pendingSteer; pendingSteer = undefined; clearTimeout(pending.timer);
        if (frame.error !== undefined) {
          const error = frame.error;
          if (error && typeof error === 'object' && !Array.isArray(error) && Number.isSafeInteger((error as Record<string, unknown>).code) && typeof (error as Record<string, unknown>).message === 'string') pending.reject(new SteeringNotSent('provider_steering_rejected'));
          else pending.reject(new Error('provider_steering_reply_invalid'));
        }
        else if (!frame.result || typeof frame.result !== 'object' || (frame.result as Record<string, unknown>).turnId !== turnId) pending.reject(new Error('provider_owner_mismatch'));
        else pending.resolve();
        return;
      }
      if (frame.method === undefined && typeof frame.id === 'number' && frame.id > 3 && frame.id <= steeringSequence) return;
      if (frame.method === undefined) {
        if (frame.error !== undefined) throw new Error('provider_request_failed');
        const result = object(frame.result);
        if (stage === 'initialize' && frame.id === 1) {
          stage = 'thread';
          await send({ method: 'initialized', params: {} });
          await validateProtocolWorkspace(plan);
          await call(send, 2, plan.request.resumeSessionId ? 'thread/resume' : 'thread/start', {
            cwd: plan.cwd, ...model, ...(sandbox ? { sandbox } : {}), approvalPolicy: 'never',
            ...(plan.request.resumeSessionId ? { threadId: plan.request.resumeSessionId, excludeTurns: true } : {}),
          });
        } else if (stage === 'thread' && frame.id === 2) {
          const id = object(result.thread).id;
          if (!isProviderSessionId(id) || (plan.request.resumeSessionId && id !== plan.request.resumeSessionId)) throw new Error('provider_session_mismatch');
          threadId = id;
          await plan.request.onSession?.(id);
          if (plan.signal.aborted) return { exitCode: null, error: 'cancelled' };
          await emit({ type: 'thread.started', thread_id: id });
          stage = 'turn';
          await validateProtocolWorkspace(plan);
          await call(send, 3, 'turn/start', {
            threadId, cwd: plan.cwd, ...model, approvalPolicy: 'never', ...(sandboxPolicy ? { sandboxPolicy } : {}),
            input: [{ type: 'text', text: `[Codevo presentation capability]\n${ARTIFACT_HINT}\n[User request]\n${plan.prompt || 'Inspect the attached images.'}` },
              ...plan.request.attachments.filter(file => file.mediaType !== 'text/plain').map(image => ({ type: 'localImage', path: image.path }))],
          });
        } else if (stage === 'turn' && frame.id === 3) {
          const id = identifier(object(result.turn).id);
          if (turnId && turnId !== id) throw new Error('provider_turn_mismatch');
          turnId = id; stage = 'running';
          await emit({ type: 'turn.started' });
          plan.request.onSteeringReady?.(async input => {
            const ownedTurn = turnId;
            if (stage !== 'running' || pendingQuestion || pendingSteer || plan.signal.aborted) throw new SteeringNotSent('steering_unavailable');
            try { await validateProtocolWorkspace(plan); } catch { throw new SteeringNotSent('workspace_identity_changed'); }
            if (stage !== 'running' || turnId !== ownedTurn || pendingQuestion || pendingSteer || plan.signal.aborted) throw new SteeringNotSent('steering_unavailable');
            const id = ++steeringSequence;
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { if (pendingSteer?.id === id) { pendingSteer = undefined; reject(new Error('steering_timeout')); } }, 15_000);
              pendingSteer = { id, resolve, reject, timer };
              void call(send, id, 'turn/steer', { threadId, expectedTurnId: ownedTurn,
                input: [{ type: 'text', text: textAttachmentPrompt(input.prompt, input.attachments) || 'Inspect the attached images.' }, ...input.attachments.filter(file => file.mediaType !== 'text/plain').map(image => ({ type: 'localImage', path: image.path }))] })
                .catch(error => { if (pendingSteer?.id === id) { clearTimeout(timer); pendingSteer = undefined; reject(error); } });
            });
          });
        } else throw new Error('provider_reply_unexpected');
        return;
      }
      const params = object(frame.params ?? {});
      // Only children explicitly linked by this root's collaboration item may
      // contribute child telemetry. Their terminal event never ends the root.
      if (frame.id === undefined && typeof params.threadId === 'string' && children.has(params.threadId)) {
        const childId = params.threadId;
        if (frame.method === 'turn/started') {
          const childTurnId = identifier(object(params.turn).id);
          const key = `${childId}:${childTurnId}`;
          if (childTurns.has(key)) return;
          if (childTurns.size >= 4096) throw new Error('provider_child_turn_limit');
          childTurns.add(key);
          children.set(childId, childTurnId);
          await emit({ v: 1, t: 'subagent', kind: 'interacted', agentThreadId: childId, agentPath: '', clipped: false });
        } else if (frame.method === 'turn/completed') {
          const childTurn = object(params.turn);
          const completedChildTurnId = identifier(childTurn.id);
          const completedKey = `${childId}:${completedChildTurnId}`;
          if (!childTurns.has(completedKey)) {
            if (childTurns.size >= 4096) throw new Error('provider_child_turn_limit');
            childTurns.add(completedKey);
          }
          if (children.get(childId) !== completedChildTurnId) return;
          children.set(childId, undefined);
          await emit({ v: 1, t: 'subagentTurnCompleted', agentThreadId: childId, durationMs: null, isError: childTurn.status !== 'completed' });
        } else if (frame.method === 'thread/closed') {
          children.set(childId, undefined);
          await emit({ v: 1, t: 'subagent', kind: 'interrupted', agentThreadId: childId, agentPath: '', clipped: false });
        }
        return;
      }

      if (frame.method === 'turn/started' && (stage === 'turn' || stage === 'running')) {
        const id = identifier(object(params.turn).id);
        if (params.threadId !== threadId || (turnId && turnId !== id)) throw new Error('provider_owner_mismatch');
        turnId = id; return;
      }
      if (frame.id !== undefined) {
        if ((typeof frame.id !== 'string' && typeof frame.id !== 'number') || String(frame.id).length > 128) throw new Error('provider_request_id_invalid');
        const key = `${typeof frame.id}:${frame.id}`;
        if (requestIds.has(key) || requestIds.size >= 1024) throw new Error('provider_request_duplicate_or_limit');
        requestIds.add(key);
        if (frame.method !== 'item/tool/requestUserInput') {
          // Approval and dynamic-tool requests never receive an implicit allow.
          await send({ id: frame.id, error: { code: -32601, message: 'Unsupported server request' } });
          return;
        }
        owner(params);
        const raw = params.questions;
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4 || !plan.request.onQuestion) throw new Error('provider_question_invalid');
        const questions = parseAgentQuestionRequest({ id: 'request', taskId: 'task', provider: 'codex', status: 'pending', questions: raw.map(value => {
          const item = object(value);
          if (item.isSecret === true) throw new Error('provider_secret_question_unsupported');
          const options = item.options ?? [];
          if (!Array.isArray(options) || options.length > 12) throw new Error('provider_question_invalid');
          return { id: identifier(item.id), header: item.header ?? '', prompt: item.question,
            multiple: false, allowCustom: true, options: options.map((value, index) => {
              const option = object(value);
              return { id: `option-${index}`, label: option.label, description: option.description ?? '' };
            }) };
        }) }).questions;
        if (pendingQuestion) throw new Error('provider_question_overlap');
        pendingQuestion = key;
        void plan.request.onQuestion(questions).then(async value => {
          if (plan.signal.aborted || stage === 'done' || pendingQuestion !== key) return;
          const response = parseAgentQuestionResponse(value, { questions });
          const answers: Record<string, { answers: string[] }> = Object.create(null) as Record<string, { answers: string[] }>;
          for (const answer of response.answers) {
            const question = questions.find(question => question.id === answer.questionId)!;
            answers[answer.questionId] = { answers: [...answer.optionIds.map(id => question.options.find(option => option.id === id)!.label), ...(answer.text ? [answer.text] : [])] };
          }
          pendingQuestion = undefined;
          await send({ id: frame.id, result: { answers } });
        }).catch(() => { if (!plan.signal.aborted && stage !== 'done') fail?.('provider_question_failed'); });
        return;
      }
      if (frame.method === 'serverRequest/resolved') {
        if (params.threadId === threadId && pendingQuestion === `${typeof params.requestId}:${params.requestId}`) {
          pendingQuestion = undefined; stage = 'done';
          return { exitCode: null, error: 'provider_question_cancelled', sessionId: threadId };
        }
      }
      if (frame.method === 'item/started' || frame.method === 'item/completed') {
        owner(params);
        const item = object(params.item);
        const completed = frame.method === 'item/completed';
        const eventType = completed ? 'item.completed' : 'item.started';
        const id = identifier(item.id);
        if (completed && (item.type === 'agentMessage' || item.type === 'reasoning')) {
          const text = item.type === 'agentMessage' ? item.text : Array.isArray(item.summary) ? item.summary.join('\n') : '';
          if (typeof text !== 'string') throw new Error('provider_item_invalid');
          // Preserve item boundaries: artifact discovery tracks Markdown fences and links per item.
          // Transport writes bounded chunks; existing JSONL parsers report oversized frames explicitly.
          await emit({ type: 'item.completed', item: { id, type: item.type === 'agentMessage' ? 'agent_message' : 'reasoning', text } });
        } else if (item.type === 'subAgentActivity') {
          // Current Codex links spawned children through this item, without a
          // legacy collabAgentToolCall. Register only an exact root-owned item.
          const childId = identifier(item.agentThreadId);
          const kind = item.kind;
          if (typeof kind !== 'string' || !['started', 'interacted', 'interrupted', 'completed'].includes(kind)) throw new Error('provider_subagent_kind_invalid');
          if (childId === threadId) throw new Error('provider_owner_mismatch');
          if (children.size >= 256 && !children.has(childId)) throw new Error('provider_child_limit');
          if (!children.has(childId)) children.set(childId, undefined);
          await emit({ v: 1, t: 'subagent', kind, agentThreadId: childId,
            ...subagentPath(item.agentPath) });
        } else if (item.type === 'collabAgentToolCall') {
          const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
          const ids: string[] = [];
          for (const raw of receivers.slice(0, 257)) {
            const childId = identifier(raw);
            if (childId === threadId) continue;
            if (children.size >= 256 && !children.has(childId)) throw new Error('provider_child_limit');
            if (!children.has(childId)) children.set(childId, undefined);
            if (ids.length < 33) ids.push(childId);
          }
          const states: Record<string, unknown> = {};
          const suppliedStates = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates) ? item.agentsStates as Record<string, unknown> : {};
          for (const id of ids) {
            const value = suppliedStates[id];
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const status = (value as Record<string, unknown>).status;
              if (typeof status === 'string') states[id] = { status: boundedSummary(status) };
            }
          }
          await emit({ type: eventType, item: { id, type: 'collab_agent_tool_call', tool: boundedSummary(item.tool), receiverThreadIds: ids, agentsStates: states } });
        } else if (item.type === 'commandExecution') {
          const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
          for (const segment of outputSegments(output)) {
            await emit({ type: eventType, item: { id, type: 'command_execution', command: boundedSummary(item.command),
              aggregated_output: segment, exit_code: item.exitCode ?? null } });
          }
        } else if (item.type === 'fileChange') {
          const changes = Array.isArray(item.changes) ? item.changes.slice(0, 24).map(value => ({ path: boundedSummary(object(value).path) })) : [];
          if (Array.isArray(item.changes) && item.changes.length > 24) changes.push({ path: '[Additional changed files omitted]' });
          await emit({ type: eventType, item: { id, type: 'file_change', changes, status: item.status } });
        } else if (item.type === 'mcpToolCall') {
          await emit({ type: eventType, item: { id, type: 'mcp_tool_call', server: boundedSummary(item.server), tool: boundedSummary(item.tool), arguments: boundedSummary(item.arguments) } });
        } else if (item.type === 'webSearch') {
          await emit({ type: eventType, item: { id, type: 'web_search', query: boundedSummary(item.query) } });
        } else if (completed && item.type === 'contextCompaction') await emit({ type: 'item.completed', item: { id, type: 'context_compaction' } });
        if (completed && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type)) && !pendingQuestion) {
          // Never await an ACK-dependent callback inside the serial receive loop.
          void plan.request.onToolBoundary?.().catch(() => {});
        }
      } else if (frame.method === 'thread/tokenUsage/updated') {
        // Resume replays the previous turn's usage before the new turn is started.
        // It is history, not usage owned by this execution; never publish or aggregate it.
        if (plan.request.resumeSessionId && (stage === 'thread' || stage === 'turn') && !turnId &&
          params.threadId === plan.request.resumeSessionId) return;
        owner(params);
        const last = object(object(params.tokenUsage).last);
        if (typeof last.inputTokens === 'number' && Number.isSafeInteger(last.inputTokens) && last.inputTokens >= 0 && typeof last.outputTokens === 'number' && Number.isSafeInteger(last.outputTokens) && last.outputTokens >= 0) {
          usage = { input_tokens: last.inputTokens, output_tokens: last.outputTokens };
        }
      } else if (frame.method === 'turn/completed') {
        const turn = object(params.turn);
        owner({ ...params, turnId: turn.id });
        dispose(); pendingQuestion = undefined;
        if (turn.status !== 'completed') {
          const error = turn.error && typeof turn.error === 'object' && !Array.isArray(turn.error) ? turn.error as Record<string, unknown> : undefined;
          await emit({ type: 'turn.failed', error: { message: typeof error?.message === 'string' ? boundedSummary(error.message) : 'Provider turn did not complete' } });
          return { exitCode: 1, error: 'provider_reported_failure', sessionId: threadId };
        }
        await emit({ type: 'turn.completed', ...(usage ? { usage } : {}) });
        return { exitCode: 0, sessionId: threadId };
      }
      return;
    },
  };
}

export function executeCodexInteractive(plan: CodexInteractivePlan): Promise<ExecutionResult> {
  return runInteractiveProcess({ ...plan, args: ['app-server', '--listen', 'stdio://', '-c', 'features.default_mode_request_user_input=true'], onOutput: plan.request.onOutput }, createCodexProtocol(plan));
}

function boundedSummary(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  return text.length > 1024 ? text.slice(0, 1024) + ' [Shortened]' : text;
}

function* outputSegments(text: string): Generator<string> {
  if (!text) { yield ''; return; }
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4096, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

/** Fence awaited initialization/session persistence before pathname-bearing RPCs. */
async function validateProtocolWorkspace(plan: CodexInteractivePlan): Promise<void> {
  const identity = plan.request.cwdIdentity;
  if (identity) {
    if (plan.cwd !== plan.request.cwd || Buffer.byteLength(plan.cwd) > 32_768) throw new Error('workspace_identity_changed');
    const canonical = await realpath(plan.cwd);
    const resolved = await lstat(canonical);
    const current = await lstat(plan.cwd);
    if (!resolved.isDirectory() || !current.isDirectory() ||
      resolved.dev !== identity.dev || resolved.ino !== identity.ino ||
      current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('workspace_identity_changed');
  }
  if (plan.signal.aborted) throw new Error('cancelled');
}

/** Match the editor's canonical tool-identity field bound without splitting UTF-8. */
function subagentPath(value: unknown): { agentPath: string; clipped: boolean } {
  if (typeof value !== 'string') return { agentPath: '', clipped: false };
  let agentPath = ''; let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 256) return { agentPath, clipped: true };
    agentPath += character; bytes += size;
  }
  return { agentPath, clipped: false };
}
