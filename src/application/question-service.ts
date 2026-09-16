import { randomUUID } from 'node:crypto';
import { RunnerError, type Task } from '../domain/contracts.js';
import { validateId } from '../domain/task-input.js';
import { parseAgentQuestionRequest, parseAgentQuestionResponse, type AgentQuestion, type AgentQuestionResponse } from '../domain/questions.js';
import type { QuestionRepository } from './question-ports.js';

/** Durable question metadata is independent from the lifetime of an HTTP client. */
export class QuestionService {
  private readonly waiting = new Map<string, { taskId: string; resolve: (value: AgentQuestionResponse) => void; reject: (error: unknown) => void }>();
  constructor(private readonly repository: QuestionRepository) {}

  list(taskId: string) { return this.repository.listQuestions(validateId(taskId)); }

  async ask(task: Task, questions: readonly AgentQuestion[], signal: AbortSignal): Promise<AgentQuestionResponse> {
    signal.throwIfAborted();
    if (this.waiting.size >= 8) throw new RunnerError('busy');
    const request = parseAgentQuestionRequest({ id: randomUUID(), taskId: task.id,
      provider: task.provider === 'claude' ? 'claudeCode' : 'codex', questions, status: 'pending' });
    let reject!: (error: unknown) => void;
    const answer = new Promise<AgentQuestionResponse>((resolve, rejectAnswer) => {
      reject = rejectAnswer;
      this.waiting.set(request.id, { taskId: task.id, resolve, reject: rejectAnswer });
    });
    // Cancellation can race the asynchronous durable admission.
    void answer.catch(() => undefined);
    const aborted = () => reject(new RunnerError('conflict'));
    signal.addEventListener('abort', aborted, { once: true });
    try {
      if (signal.aborted) aborted();
      await this.repository.createQuestion(request);
      signal.throwIfAborted();
      return await answer;
    } finally {
      signal.removeEventListener('abort', aborted);
      this.waiting.delete(request.id);
      if (signal.aborted) await this.repository.expireQuestions(task.id);
    }
  }

  async answer(taskId: string, requestId: string, input: unknown) {
    validateId(taskId); validateId(requestId);
    const questions = await this.repository.listQuestions(taskId);
    const request = questions.find(candidate => candidate.id === requestId);
    if (!request) throw new RunnerError('not_found');
    let response: AgentQuestionResponse;
    try { response = parseAgentQuestionResponse(input, request); }
    catch { throw new RunnerError('invalid_input'); }
    const waiter = this.waiting.get(requestId);
    if (request.status === 'pending' && (!waiter || waiter.taskId !== taskId)) throw new RunnerError('conflict');
    const result = await this.repository.answerQuestion(taskId, requestId, response);
    // The exact invocation owns this waiter; reconnects never start another turn.
    if (this.waiting.get(requestId) === waiter) waiter?.resolve(response);
    return result;
  }

  async expire(taskId?: string) {
    await this.repository.expireQuestions(taskId);
    for (const [id, waiter] of this.waiting) {
      if (taskId !== undefined && waiter.taskId !== taskId) continue;
      this.waiting.delete(id);
      waiter.reject(new RunnerError('conflict'));
    }
  }
}
