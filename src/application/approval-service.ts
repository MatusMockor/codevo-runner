import { randomUUID } from 'node:crypto';
import { RunnerError, type Task } from '../domain/contracts.js';
import { EXECUTION_LIMITS } from '../domain/execution.js';
import { validateId } from '../domain/task-input.js';
import {
  APPROVAL_LIMITS, parseAgentApprovalAnswer, parseAgentApprovalRequest,
  type AgentApprovalInput, type AgentApprovalOutcome, type AgentApprovalRequest,
} from '../domain/approvals.js';
import type { ApprovalRepository } from './approval-ports.js';

type Waiter = {
  readonly taskId: string;
  readonly resolve: (outcome: AgentApprovalOutcome) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const WAITER_LIMIT = EXECUTION_LIMITS.activeTasks * APPROVAL_LIMITS.pending;

export class ApprovalService {
  private readonly waiting = new Map<string, Waiter>();
  private readonly timeoutMs: number;

  constructor(private readonly repository: ApprovalRepository, options: Readonly<{ timeoutMs?: number }> = {}) {
    this.timeoutMs = options.timeoutMs ?? APPROVAL_LIMITS.timeoutMs;
  }

  list(taskId: string): Promise<readonly AgentApprovalRequest[]> {
    return this.repository.listApprovals(validateId(taskId));
  }

  async ask(task: Task, input: AgentApprovalInput, signal: AbortSignal): Promise<AgentApprovalOutcome> {
    signal.throwIfAborted();
    if (this.waiting.size >= WAITER_LIMIT) throw new RunnerError('busy');
    const request = this.pendingRequest(task, input);
    const { waiter, outcome } = this.register(request);
    const aborted = () => waiter.reject(new RunnerError('conflict'));
    signal.addEventListener('abort', aborted, { once: true });
    try {
      await this.repository.createApproval(request);
      signal.throwIfAborted();
      waiter.timer = setTimeout(() => { void this.timeOut(request, waiter); }, this.timeoutMs);
      return await outcome;
    } finally {
      signal.removeEventListener('abort', aborted);
      this.release(request.id, waiter);
      if (signal.aborted) await this.repository.settleApproval(task.id, request.id, 'cancelled').catch(() => undefined);
    }
  }

  async answer(taskId: string, requestId: string, input: unknown): Promise<AgentApprovalRequest> {
    validateId(taskId);
    validateId(requestId);
    const requests = await this.repository.listApprovals(taskId);
    const request = requests.find(candidate => candidate.id === requestId);
    if (!request) throw new RunnerError('not_found');
    const { decision } = parseAgentApprovalAnswer(input, request);
    const waiter = this.waiting.get(requestId);
    if (request.status === 'pending' && waiter?.taskId !== taskId) throw new RunnerError('conflict');
    const settled = await this.repository.answerApproval(taskId, requestId, decision);
    if (waiter && this.waiting.get(requestId) === waiter) waiter.resolve(decision);
    return settled;
  }

  async expire(taskId?: string): Promise<void> {
    try {
      await this.repository.expireApprovals(taskId);
    } finally {
      this.rejectWaiters(taskId);
    }
  }

  private pendingRequest(task: Task, input: AgentApprovalInput): AgentApprovalRequest {
    return parseAgentApprovalRequest({
      id: randomUUID(),
      taskId: task.id,
      provider: task.provider === 'claude' ? 'claudeCode' : 'codex',
      ...input,
      status: 'pending',
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    });
  }

  private register(request: AgentApprovalRequest): { waiter: Waiter; outcome: Promise<AgentApprovalOutcome> } {
    let waiter!: Waiter;
    const outcome = new Promise<AgentApprovalOutcome>((resolve, reject) => {
      waiter = { taskId: request.taskId, resolve, reject };
    });
    void outcome.catch(() => undefined);
    this.waiting.set(request.id, waiter);
    return { waiter, outcome };
  }

  private release(requestId: string, waiter: Waiter): void {
    clearTimeout(waiter.timer);
    if (this.waiting.get(requestId) === waiter) this.waiting.delete(requestId);
  }

  private async timeOut(request: AgentApprovalRequest, waiter: Waiter): Promise<void> {
    if (this.waiting.get(request.id) !== waiter) return;
    const transitioned = await this.repository.timeoutApproval(request.taskId, request.id).catch(() => true);
    if (!transitioned || this.waiting.get(request.id) !== waiter) return;
    this.waiting.delete(request.id);
    waiter.resolve('unanswered');
  }

  private rejectWaiters(taskId: string | undefined): void {
    for (const [id, waiter] of this.waiting) {
      if (taskId !== undefined && waiter.taskId !== taskId) continue;
      this.waiting.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new RunnerError('conflict'));
    }
  }
}
