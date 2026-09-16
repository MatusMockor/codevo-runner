import type { ExecutionRequest, ExecutionResult } from '../../domain/execution.js';
import type { AgentQuestion } from '../../domain/questions.js';
import { isProviderSessionId } from '../../domain/provider-output.js';
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
  let sessionId: string | undefined;
  let questionId: string | undefined;
  const seen = new Set<string>();
  return {
    async start(send) {
      await send({ type: 'control_request', request_id: 'codevo-initialize', request: { subtype: 'initialize', hooks: {} } });
    },
    async receive(frame, send, fail) {
      if (frame.type === 'control_response') {
        const response = record(frame.response);
        if (initialized || response.request_id !== 'codevo-initialize' || response.subtype !== 'success') throw new Error('invalid_initialize');
        initialized = true;
        await send({ type: 'user', message: { role: 'user', content: [...plan.images,
          { type: 'text', text: plan.prompt || 'Inspect the attached images.' }] } });
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
        if (!isProviderSessionId(frame.session_id) || (plan.request.resumeSessionId && plan.request.resumeSessionId !== frame.session_id) || (sessionId && sessionId !== frame.session_id)) throw new Error('session_mismatch');
        sessionId = frame.session_id;
        await plan.request.onSession?.(sessionId);
      }
      if (!['system', 'assistant', 'user', 'result', 'stream_event', 'tool_progress', 'tool_use_summary', 'rate_limit_event'].includes(String(frame.type))) return;
      await emitInteractiveOutput(plan.request.onOutput, 'stdout', JSON.stringify(frame) + '\n');
      if (frame.type === 'result') {
        if (questionId) { questionId = undefined; return { exitCode: null, error: 'provider_question_unanswered' }; }
        if (!sessionId || frame.session_id !== sessionId) throw new Error('session_mismatch');
        return { exitCode: frame.is_error === false && frame.subtype === 'success' ? 0 : 1, sessionId,
          ...(frame.is_error === false && frame.subtype === 'success' ? {} : { error: 'provider_reported_failure' }) };
      }
    },
  };
}
export function executeClaudeInteractive(plan: ClaudePlan): Promise<ExecutionResult> {
  return runInteractiveProcess({ ...plan, args: [...plan.args, '--permission-prompt-tool', 'stdio'], onOutput: plan.request.onOutput }, createClaudeProtocol(plan));
}
