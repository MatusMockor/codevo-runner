import type { DatabaseSync } from 'node:sqlite';
import { RunnerError, type Task } from '../../domain/contracts.js';
import { parseAgentQuestionRequest, parseAgentQuestionResponse, type AgentQuestionRequest, type AgentQuestionResponse } from '../../domain/questions.js';

// Includes JSON escaping, not merely visible UTF-8 text. One pending response is reserved.
export const MAX_TASK_QUESTION_BYTES = 1024 * 1024;
const RESERVED_ANSWER_BYTES = 200 * 1024;

export const QUESTION_SCHEMA = `CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled','expired')),
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS questions_one_pending ON questions(task_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS questions_task ON questions(task_id);`;

export class QuestionDatabase {
  constructor(private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly getTask: (id: string) => Task,
    private readonly requireCapacity: () => void) {}

  listQuestions(taskId: string): readonly AgentQuestionRequest[] {
    this.getTask(taskId);
    return this.db.prepare('SELECT payload FROM questions WHERE task_id=? ORDER BY rowid LIMIT 32').all(taskId)
      .map(row => parseAgentQuestionRequest(JSON.parse(String(row['payload']))));
  }

  createQuestion(input: AgentQuestionRequest): AgentQuestionRequest {
    const request = parseAgentQuestionRequest(input);
    if (request.status !== 'pending') throw new RunnerError('invalid_input');
    return this.transaction(() => {
      const task = this.getTask(request.taskId);
      if (task.status !== 'running' || (task.provider === 'claude' ? 'claudeCode' : task.provider) !== request.provider) throw new RunnerError('conflict');
      const existing = this.db.prepare('SELECT payload FROM questions WHERE id=?').get(request.id);
      if (existing) {
        const previous = parseAgentQuestionRequest(JSON.parse(String(existing['payload'])));
        if (JSON.stringify(previous) !== JSON.stringify(request)) throw new RunnerError('conflict');
        return previous;
      }
      if (this.db.prepare("SELECT 1 FROM questions WHERE task_id=? AND status='pending'").get(request.taskId)) throw new RunnerError('conflict');
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM questions WHERE task_id=?').get(request.taskId)!['n']);
      if (count >= 32) throw new RunnerError('quota_exceeded');
      const payload = JSON.stringify(request);
      this.requireQuestionBytes(request.taskId, Buffer.byteLength(payload) + RESERVED_ANSWER_BYTES);
      this.requireCapacity();
      this.db.prepare('INSERT INTO questions(id,task_id,status,payload) VALUES(?,?,?,?)').run(request.id, request.taskId, request.status, payload);
      this.requireCapacity();
      return request;
    });
  }

  answerQuestion(taskId: string, id: string, input: AgentQuestionResponse): AgentQuestionRequest {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      const row = this.db.prepare('SELECT payload FROM questions WHERE task_id=? AND id=?').get(taskId, id);
      if (!row) throw new RunnerError('not_found');
      const previous = parseAgentQuestionRequest(JSON.parse(String(row['payload'])));
      const response = parseAgentQuestionResponse(input, previous);
      if (previous.status === 'answered' && JSON.stringify(previous.answers) === JSON.stringify(response.answers)) return previous;
      if (task.status !== 'running') throw new RunnerError('conflict');
      if (previous.status !== 'pending') throw new RunnerError('conflict');
      const answered: AgentQuestionRequest = { ...previous, status: 'answered', answers: response.answers };
      const payload = JSON.stringify(answered);
      this.requireQuestionBytes(taskId, Buffer.byteLength(payload), id);
      this.requireCapacity();
      this.db.prepare("UPDATE questions SET status='answered',payload=? WHERE task_id=? AND id=? AND status='pending'").run(payload, taskId, id);
      this.requireCapacity();
      return answered;
    });
  }

  private requireQuestionBytes(taskId: string, additionalBytes: number, replacedId = ''): void {
    const stored = Number(this.db.prepare('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM questions WHERE task_id=? AND id<>?').get(taskId, replacedId)!['bytes']);
    if (stored + additionalBytes > MAX_TASK_QUESTION_BYTES) throw new RunnerError('quota_exceeded');
  }

  expireQuestions(taskId?: string): void {
    this.transaction(() => { if (taskId !== undefined) this.getTask(taskId); this.settlePending(taskId, 'expired'); });
  }

  /** Called within the owning task transition transaction. */
  settlePending(taskId: string | undefined, status: 'expired' | 'cancelled'): void {
    if (taskId === undefined) this.db.prepare("UPDATE questions SET status=?,payload=json_set(payload,'$.status',?) WHERE status='pending'").run(status, status);
    else this.db.prepare("UPDATE questions SET status=?,payload=json_set(payload,'$.status',?) WHERE task_id=? AND status='pending'").run(status, status, taskId);
  }
}
