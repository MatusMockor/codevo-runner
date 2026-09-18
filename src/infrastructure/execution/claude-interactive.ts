import { randomUUID } from 'node:crypto';
import { SteeringNotSent } from '../../domain/steering.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { LIMITS } from '../../domain/contracts.js';
import type { ExecutionRequest, ExecutionResult } from '../../domain/execution.js';
import type { AgentQuestion } from '../../domain/questions.js';
import { isProviderSessionId } from '../../domain/provider-output.js';
import { ClaudeBackgroundTasks } from '../../domain/claude-background-tasks.js';
import { emitInteractiveOutput, runInteractiveProcess, type InteractiveProcessPlan, type InteractiveProtocol } from './interactive-process.js';

type ClaudePlan = Omit<InteractiveProcessPlan, 'onOutput'> & Readonly<{
  request: ExecutionRequest; prompt: string; images: readonly unknown[];
}>;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_question');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_question');
  return value;
}
export function parseClaudeQuestions(input: Record<string, unknown>): readonly AgentQuestion[] {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4) throw new Error('invalid_question');
  const prompts = new Set<string>();
  return input.questions.map((raw, index) => {
    const question = record(raw);
    if (!Array.isArray(question.options) || question.options.length > 8 || question.options.length < 1) throw new Error('invalid_question');
    if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') throw new Error('invalid_question');
    const prompt = text(question.question, 4096);
    if (prompts.has(prompt)) throw new Error('duplicate_question');
    prompts.add(prompt);
    const labels = new Set<string>();
    return { id: `q${index}`, header: text(question.header, 120), prompt,
      multiple: question.multiSelect === true, allowCustom: true,
      options: question.options.map((rawOption, optionIndex) => {
        const option = record(rawOption);
        const label = text(option.label, 512);
        if (labels.has(label)) throw new Error('duplicate_option');
        labels.add(label);
        return { id: `o${optionIndex}`, label, description: typeof option.description === 'string' && option.description.length <= 2048 ? option.description : '' };
      }) };
  });
}
export function createClaudeProtocol(plan: ClaudePlan): InteractiveProtocol {
  let initialized = false;
  let done = false;
  let steering = false;
  const initialCommand = randomUUID();
  let lifecycleSupported = false;
  let lifecycleSession: string | undefined;
  let registerSteering: (() => void) | undefined;
  let resultGeneration = 0;
  let lastSuccess: ExecutionResult | undefined;
  const commands = new Map<string, { startedAt?: number; completed: boolean; acknowledged: boolean; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const settleCompleted = () => {
    for (const [id, command] of commands) {
      if (command.completed && command.startedAt !== undefined && resultGeneration > command.startedAt) commands.delete(id);
    }
  };
  const clearCommands = () => { for (const command of commands.values()) { clearTimeout(command.timer); if (!command.acknowledged) command.reject(new Error('steering_closed')); } commands.clear(); };
  let sessionId: string | undefined;
  let questionId: string | undefined;
  const seen = new Set<string>();
  const backgroundTasks = new ClaudeBackgroundTasks();
  return {
    dispose() { done = true; clearCommands(); plan.request.onSteeringReady?.(undefined); },
    async start(send) {
      await send({ type: 'control_request', request_id: 'codevo-initialize', request: { subtype: 'initialize', hooks: {} } });
    },
    async receive(frame, send, fail) {
      if (frame.type === 'control_response') {
        const response = record(frame.response);
        if (initialized || response.request_id !== 'codevo-initialize' || response.subtype !== 'success') throw new Error('invalid_initialize');
        initialized = true;
        await send({ type: 'user', uuid: initialCommand, message: { role: 'user', content: [...plan.images,
          { type: 'text', text: plan.prompt || 'Inspect the attached images.' }] } });
        return;
      }
      if (frame.type === 'command_lifecycle') {
        if (!isProviderSessionId(frame.session_id) || (sessionId && frame.session_id !== sessionId)) throw new Error('session_mismatch');
        if (frame.command_uuid === initialCommand && ['queued', 'started', 'completed'].includes(String(frame.state))) {
          lifecycleSupported = true; lifecycleSession = frame.session_id; registerSteering?.();
        }
        const command = typeof frame.command_uuid === 'string' ? commands.get(frame.command_uuid) : undefined;
        if (!command) return;
        if (frame.state === 'queued' || frame.state === 'started' || frame.state === 'completed') {
          if (frame.state === 'started' && command.startedAt === undefined) command.startedAt = resultGeneration;
          if (!command.acknowledged) { command.acknowledged = true; clearTimeout(command.timer); command.resolve(); }
          if (frame.state === 'completed') command.completed = true;
          settleCompleted();
          if (lastSuccess && !commands.size && !backgroundTasks.active) {
            done = true; plan.request.onSteeringReady?.(undefined); return lastSuccess;
          }
        } else if (['cancelled', 'discarded', 'refused'].includes(String(frame.state))) {
          clearTimeout(command.timer); commands.delete(String(frame.command_uuid));
          if (!command.acknowledged) {
            command.reject(new SteeringNotSent('provider_steering_rejected'));
            if (lastSuccess && !commands.size && !backgroundTasks.active) {
              done = true; plan.request.onSteeringReady?.(undefined); return lastSuccess;
            }
          }
          else { done = true; clearCommands(); plan.request.onSteeringReady?.(undefined); return { exitCode: 1, error: 'provider_steering_failed', ...(sessionId ? { sessionId } : {}) }; }
        }
        return;
      }
      if (frame.type === 'control_request') {
        if (!initialized || !sessionId) throw new Error('question_before_session');
        const id = text(frame.request_id, 256);
        if (seen.has(id) || seen.size >= 128 || questionId) throw new Error('duplicate_or_concurrent_question');
        seen.add(id);
        const request = record(frame.request);
        let response: Record<string, unknown> = { behavior: 'deny', message: 'Interactive permission approval is not supported by this runner.' };
        if (request.subtype === 'can_use_tool' && request.tool_name === 'AskUserQuestion') {
          const input = record(request.input);
          const questions = parseClaudeQuestions(input);
          if (!plan.request.onQuestion) throw new Error('questions_unavailable');
          questionId = id;
          const answerQuestion = plan.request.onQuestion;
          void (async () => {
          const answers = await answerQuestion(questions);
          if (plan.signal.aborted) throw new Error('cancelled');
          const mapped: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const question of questions) {
            const answer = answers.answers.find(value => value.questionId === question.id);
            if (!answer) throw new Error('missing_answer');
            const labels = answer.optionIds.map(optionId => {
              const option = question.options.find(value => value.id === optionId);
              if (!option) throw new Error('unknown_option');
              return option.label;
            });
            if (answer.text) labels.push(answer.text);
            mapped[question.prompt] = labels.join(', ');
          }
          response = { behavior: 'allow', updatedInput: { ...input, answers: mapped } };
          if (questionId !== id) return;
          questionId = undefined;
          await send({ type: 'control_response', response: { subtype: 'success', request_id: id,
            response: { ...response, ...(typeof request.tool_use_id === 'string' ? { toolUseID: request.tool_use_id } : {}) } } });
          })().catch(async () => {
            if (questionId !== id || plan.signal.aborted) return;
            if (fail) { fail('provider_question_failed'); return; }
            questionId = undefined;
            await send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Question could not be answered.' } }).catch(() => {});
          });
          return;
        }
        await send({ type: 'control_response', response: { subtype: 'success', request_id: id,
          response: { ...response, ...(typeof request.tool_use_id === 'string' ? { toolUseID: request.tool_use_id } : {}) } } });
        return;
      }
      if (frame.type === 'control_cancel_request') { questionId = undefined; return { exitCode: null, error: 'provider_question_cancelled' }; }
      if (frame.type === 'system' && frame.subtype === 'init') {
        if (!isProviderSessionId(frame.session_id) || (plan.request.resumeSessionId && plan.request.resumeSessionId !== frame.session_id) || (sessionId && sessionId !== frame.session_id) || (lifecycleSession && lifecycleSession !== frame.session_id)) throw new Error('session_mismatch');
        sessionId = frame.session_id;
        await plan.request.onSession?.(sessionId);
        registerSteering = () => { if (lifecycleSupported && !done) plan.request.onSteeringReady?.(async input => {
          const ownedSession = sessionId;
          const assertOwner = () => { if (done || plan.signal.aborted || questionId || sessionId !== ownedSession) throw new SteeringNotSent('steering_unavailable'); };
          assertOwner();
          if (steering || commands.size >= 32) throw new SteeringNotSent('steering_unavailable');
          steering = true;
          let writing = false;
          try {
            if (input.attachments.length > LIMITS.attachmentsPerTask) throw new Error('attachment_input_invalid');
            const images: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];
            for (const attachment of input.attachments) {
              if (!isAbsolute(attachment.path) || !['image/png', 'image/jpeg'].includes(attachment.mediaType)) throw new Error('attachment_input_invalid');
              const handle = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                assertOwner();
                const stat = await handle.stat(); assertOwner();
                if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.attachmentBytes) throw new Error('attachment_input_invalid');
                const bytes = Buffer.alloc(stat.size);
                let offset = 0;
                while (offset < bytes.length) {
                  const read = await handle.read(bytes, offset, bytes.length - offset, offset); assertOwner();
                  if (!read.bytesRead) throw new Error('attachment_changed');
                  offset += read.bytesRead;
                }
                images.push({ type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: bytes.toString('base64') } });
              } finally { await handle.close(); }
            }
            assertOwner();
            const uuid = randomUUID();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('steering_timeout')), 15_000);
              commands.set(uuid, { completed: false, acknowledged: false, resolve, reject, timer });
              writing = true;
              void send({ type: 'user', uuid, session_id: ownedSession, message: { role: 'user', content: [...images, { type: 'text', text: input.prompt || 'Inspect the attached images.' }] } })
                .catch(error => { clearTimeout(timer); reject(error); });
            });
          } catch (error) {
            if (!writing) throw new SteeringNotSent(error instanceof Error ? error.message : 'steering_input_invalid');
            throw error;
          } finally { steering = false; }
        }); };
        registerSteering();
      }
      if (!['system', 'assistant', 'user', 'result', 'stream_event', 'tool_progress', 'tool_use_summary', 'rate_limit_event'].includes(String(frame.type))) return;
      backgroundTasks.observe(frame, sessionId);
      await emitInteractiveOutput(plan.request.onOutput, 'stdout', JSON.stringify(frame) + '\n');
      if (frame.type === 'user' && !questionId && !done && frame.parent_tool_use_id == null) {
        const content = frame.message && typeof frame.message === 'object' ? (frame.message as Record<string, unknown>).content : undefined;
        if (Array.isArray(content) && content.some(item => item && typeof item === 'object' && item.type === 'tool_result')) {
          void plan.request.onToolBoundary?.().catch(() => {});
        }
      }
      if (frame.type === 'result') {
        if (questionId) { questionId = undefined; return { exitCode: null, error: 'provider_question_unanswered' }; }
        if (!sessionId || frame.session_id !== sessionId) throw new Error('session_mismatch');
        resultGeneration++;
        settleCompleted();
        if (frame.is_error === false && frame.subtype === 'success') {
          lastSuccess = { exitCode: 0, sessionId };
          if (commands.size) return;
        }
        // Keep bidirectional stdin alive through the delayed assistant answer. A task's
        // terminal notification alone is not the final foreground result.
        if (frame.is_error === false && frame.subtype === 'success' && backgroundTasks.active) {
          void plan.request.onToolBoundary?.().catch(() => {});
          return;
        }
        done = true; plan.request.onSteeringReady?.(undefined);
        return { exitCode: frame.is_error === false && frame.subtype === 'success' ? 0 : 1, sessionId,
          ...(frame.is_error === false && frame.subtype === 'success' ? {} : { error: 'provider_reported_failure' }) };
      }
    },
  };
}
export function executeClaudeInteractive(plan: ClaudePlan): Promise<ExecutionResult> {
  return runInteractiveProcess({ ...plan, completion: 'provider-exit', args: [...plan.args, '--permission-prompt-tool', 'stdio'], onOutput: plan.request.onOutput }, createClaudeProtocol(plan));
}
