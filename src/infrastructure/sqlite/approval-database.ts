import type { DatabaseSync } from 'node:sqlite';
import { RunnerError, type Task } from '../../domain/contracts.js';
import {
  APPROVAL_LIMITS, parseAgentApprovalAnswer, parseAgentApprovalRequest, settledApproval,
  type AgentApprovalDecision, type AgentApprovalRequest,
} from '../../domain/approvals.js';

export const MAX_TASK_APPROVAL_BYTES = 2 * 1024 * 1024;
const LISTED_APPROVALS = APPROVAL_LIMITS.pending + APPROVAL_LIMITS.retained;

export const APPROVAL_SCHEMA = `CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled','expired','timedOut')),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(task_id) WHERE status='pending';`;

type UnansweredStatus = 'cancelled' | 'expired' | 'timedOut';

export class ApprovalDatabase {
  constructor(private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly getTask: (id: string) => Task,
    private readonly requireCapacity: () => void) {}

  listApprovals(taskId: string): readonly AgentApprovalRequest[] {
    this.getTask(taskId);
    return this.db.prepare('SELECT payload FROM approvals WHERE task_id=? ORDER BY rowid LIMIT ?').all(taskId, LISTED_APPROVALS)
      .map(row => parseAgentApprovalRequest(JSON.parse(String(row['payload']))));
  }

  createApproval(input: AgentApprovalRequest): AgentApprovalRequest {
    const request = parseAgentApprovalRequest(input);
    if (request.status !== 'pending') throw new RunnerError('invalid_input');
    return this.transaction(() => {
      const task = this.getTask(request.taskId);
      if (task.status !== 'running' || providerOf(task) !== request.provider) throw new RunnerError('conflict');
      if (this.pendingCount(request.taskId) >= APPROVAL_LIMITS.pending) throw new RunnerError('quota_exceeded');
      this.evictSettled(request.taskId);
      const payload = JSON.stringify(request);
      this.makeRoom(request.taskId, Buffer.byteLength(payload));
      this.requireCapacity();
      this.db.prepare('INSERT INTO approvals(id,task_id,status,payload) VALUES(?,?,?,?)').run(request.id, request.taskId, request.status, payload);
      this.requireCapacity();
      return request;
    });
  }

  answerApproval(taskId: string, id: string, input: AgentApprovalDecision): AgentApprovalRequest {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      const previous = this.find(taskId, id);
      const { decision } = parseAgentApprovalAnswer({ decision: input }, previous);
      if (settledBy(previous) === decision) return previous;
      if (task.status !== 'running' || previous.status !== 'pending') throw new RunnerError('conflict');
      const answered = settledApproval(previous, decision);
      this.requireCapacity();
      this.db.prepare("UPDATE approvals SET status=?,payload=? WHERE task_id=? AND id=? AND status='pending'").run(answered.status, JSON.stringify(answered), taskId, id);
      this.requireCapacity();
      return answered;
    });
  }

  timeoutApproval(taskId: string, id: string): boolean {
    return this.transaction(() => this.settleOne(taskId, id, 'timedOut'));
  }

  settleApproval(taskId: string, id: string, status: 'cancelled'): void {
    if (status !== 'cancelled') throw new RunnerError('invalid_input');
    this.transaction(() => this.settleOne(taskId, id, status));
  }

  expireApprovals(taskId?: string): void {
    this.transaction(() => {
      if (taskId !== undefined) this.getTask(taskId);
      this.settlePending(taskId, 'expired');
    });
  }

  settlePending(taskId: string | undefined, status: 'expired' | 'cancelled'): void {
    if (taskId === undefined) {
      this.db.prepare("UPDATE approvals SET status=?,payload=json_set(payload,'$.status',?) WHERE status='pending'").run(status, status);
      return;
    }
    this.db.prepare("UPDATE approvals SET status=?,payload=json_set(payload,'$.status',?) WHERE task_id=? AND status='pending'").run(status, status, taskId);
  }

  hasPending(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM approvals WHERE task_id=? AND status='pending' LIMIT 1").get(taskId));
  }

  pendingTaskIds(): ReadonlySet<string> {
    return new Set(this.db.prepare("SELECT DISTINCT task_id FROM approvals WHERE status='pending'").all().map(row => String(row['task_id'])));
  }

  private find(taskId: string, id: string): AgentApprovalRequest {
    const row = this.db.prepare('SELECT payload FROM approvals WHERE task_id=? AND id=?').get(taskId, id);
    if (!row) throw new RunnerError('not_found');
    return parseAgentApprovalRequest(JSON.parse(String(row['payload'])));
  }

  private settleOne(taskId: string, id: string, status: UnansweredStatus): boolean {
    const result = this.db.prepare("UPDATE approvals SET status=?,payload=json_set(payload,'$.status',?) WHERE task_id=? AND id=? AND status='pending'").run(status, status, taskId, id);
    return Number(result.changes) === 1;
  }

  private pendingCount(taskId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM approvals WHERE task_id=? AND status='pending'").get(taskId)!['n']);
  }

  private evictSettled(taskId: string): void {
    this.db.prepare(`DELETE FROM approvals WHERE task_id=? AND status<>'pending' AND rowid NOT IN (
      SELECT rowid FROM approvals WHERE task_id=? AND status<>'pending' ORDER BY rowid DESC LIMIT ?)`).run(taskId, taskId, APPROVAL_LIMITS.retained);
  }

  private makeRoom(taskId: string, additionalBytes: number): void {
    while (this.storedBytes(taskId) + additionalBytes > MAX_TASK_APPROVAL_BYTES) {
      if (!this.evictOldestSettled(taskId)) throw new RunnerError('quota_exceeded');
    }
  }

  private storedBytes(taskId: string): number {
    return Number(this.db.prepare('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM approvals WHERE task_id=?').get(taskId)!['bytes']);
  }

  private evictOldestSettled(taskId: string): boolean {
    const result = this.db.prepare(`DELETE FROM approvals WHERE rowid=(
      SELECT rowid FROM approvals WHERE task_id=? AND status<>'pending' ORDER BY rowid LIMIT 1)`).run(taskId);
    return Number(result.changes) === 1;
  }
}

function providerOf(task: Task): AgentApprovalRequest['provider'] {
  if (task.provider === 'claude') return 'claudeCode';
  return 'codex';
}

function settledBy(request: AgentApprovalRequest): AgentApprovalDecision | undefined {
  if (request.status === 'approved' || request.status === 'denied') return request.decision;
  return undefined;
}
