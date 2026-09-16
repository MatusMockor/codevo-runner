import type { ExecutionRequest, ExecutionResult } from '../../domain/execution.js';
import { ARTIFACT_HINT } from '../../domain/artifact-hint.js';
import { isProviderSessionId } from '../../domain/provider-output.js';
import { parseAgentQuestionRequest, parseAgentQuestionResponse } from '../../domain/questions.js';
import { emitInteractiveOutput, runInteractiveProcess, type InteractiveProtocol, type InteractiveSend } from './interactive-process.js';

export interface CodexInteractivePlan {
  readonly executable: string;
  readonly cwd: string;
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
  let pendingQuestion: string | undefined;
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
    async start(send) {
      await call(send, 1, 'initialize', { clientInfo: { name: 'codevo_runner', title: 'Codevo Runner', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    },
    async receive(frame, send, fail): Promise<ExecutionResult | undefined> {
      if (plan.signal.aborted) return { exitCode: null, error: 'cancelled' };
      if (stage === 'done') throw new Error('provider_protocol_finished');
      if (frame.method === undefined) {
        if (frame.error !== undefined) throw new Error('provider_request_failed');
        const result = object(frame.result);
        if (stage === 'initialize' && frame.id === 1) {
          stage = 'thread';
          await send({ method: 'initialized', params: {} });
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
          await call(send, 3, 'turn/start', {
            threadId, cwd: plan.cwd, ...model, approvalPolicy: 'never', ...(sandboxPolicy ? { sandboxPolicy } : {}),
            input: [{ type: 'text', text: `[Codevo presentation capability]\n${ARTIFACT_HINT}\n[User request]\n${plan.prompt || 'Inspect the attached images.'}` },
              ...plan.request.attachments.map(image => ({ type: 'localImage', path: image.path }))],
          });
        } else if (stage === 'turn' && frame.id === 3) {
          const id = identifier(object(result.turn).id);
          if (turnId && turnId !== id) throw new Error('provider_turn_mismatch');
          turnId = id; stage = 'running';
          await emit({ type: 'turn.started' });
        } else throw new Error('provider_reply_unexpected');
        return;
      }
      const params = object(frame.params ?? {});
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
      } else if (frame.method === 'thread/tokenUsage/updated') {
        owner(params);
        const last = object(object(params.tokenUsage).last);
        if (typeof last.inputTokens === 'number' && Number.isSafeInteger(last.inputTokens) && last.inputTokens >= 0 && typeof last.outputTokens === 'number' && Number.isSafeInteger(last.outputTokens) && last.outputTokens >= 0) {
          usage = { input_tokens: last.inputTokens, output_tokens: last.outputTokens };
        }
      } else if (frame.method === 'turn/completed') {
        const turn = object(params.turn);
        owner({ ...params, turnId: turn.id });
        stage = 'done'; pendingQuestion = undefined;
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
