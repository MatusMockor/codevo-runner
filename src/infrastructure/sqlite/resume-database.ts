import { parseInstructionSnapshot } from '../../domain/instructions.js';
import { parseLaunchOptions } from '../../domain/launch.js';
import { isProviderSessionId, ProviderOutputParser } from '../../domain/provider-output.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RunnerError, type Task, type TaskEvent } from '../../domain/contracts.js';
import type { ContinueTask, ResumeState } from '../../domain/task-resume.js';

export const RESUME_SCHEMA = `CREATE TABLE IF NOT EXISTS conversations (
  root_id TEXT PRIMARY KEY REFERENCES tasks(id), latest_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT
);`;

type Dependencies = Readonly<{
  transaction<T>(action: () => T): T;
  getTask(id: string): Task;
  requireCapacity(): void;
  getAttachment(id: string): unknown;
  wakeThread(id: string): void;
  event(id: string, type: TaskEvent['type']): void;
}>;

export class ResumeDatabase {
  constructor(private readonly db: DatabaseSync, private readonly dependencies: Dependencies) {}
  getTaskSession(id: string): { sessionId: string | null; workspaceTaskId: string } {
    const task = this.dependencies.getTask(id);
    const root = task.conversationId ?? task.id;
    this.recoverLegacy(task);
    const row = this.db.prepare('SELECT session_id FROM conversations WHERE root_id=?').get(root);
    return { sessionId: row?.['session_id'] as string | null ?? null, workspaceTaskId: root };
  }
  getResumeState(id: string): ResumeState {
    const task = this.dependencies.getTask(id);
    const root = task.conversationId ?? task.id;
    this.recoverLegacy(task);
    const row = this.db.prepare('SELECT latest_id,session_id FROM conversations WHERE root_id=?').get(root);
    if (row && row['latest_id'] !== id) return { available: false, reason: 'newer_turn_exists' };
    if (['draft', 'queued', 'running'].includes(task.status)) return { available: false, reason: 'task_not_finished' };
    if (!task.projectId || !row?.['session_id']) return { available: false, reason: 'session_unavailable' };
    return { available: true, reason: null };
  }
  private recoverLegacy(task: Task): void {
    if (task.conversationId || !task.projectId || ['draft', 'queued', 'running'].includes(task.status)) return;
    if (this.db.prepare('SELECT root_id FROM conversations WHERE root_id=?').get(task.id)) return;
    const parser = new ProviderOutputParser(task.provider);
    const rows = this.db.prepare("SELECT data FROM events WHERE task_id=? AND type='task.output' ORDER BY sequence LIMIT 1024").all(task.id);
    for (const row of rows) {
      const data: unknown = JSON.parse(row['data'] as string);
      if (!data || typeof data !== 'object') continue;
      const output = data as Record<string, unknown>;
      if (output['channel'] === 'stdout' && typeof output['text'] === 'string') parser.push(output['text']);
    }
    const session = parser.finish().sessionId;
    if (session) { this.captureSession(task.id, session); return; }
    this.db.prepare('INSERT OR IGNORE INTO conversations(root_id,latest_id) VALUES(?,?)').run(task.id, task.id);
  }
  /** A single write also makes legacy recovery durable outside a caller transaction. */
  captureSession(id: string, sessionId: string): void {
    if (!isProviderSessionId(sessionId)) throw new RunnerError('invalid_input');
    const task = this.dependencies.getTask(id);
    const root = task.conversationId ?? task.id;
    const stored = this.db.prepare('SELECT latest_id,session_id FROM conversations WHERE root_id=?').get(root);
    if (stored && stored['latest_id'] !== id) return;
    if (stored?.['session_id'] && stored['session_id'] !== sessionId) throw new RunnerError('conflict');
    this.db.prepare(`INSERT INTO conversations(root_id,latest_id,session_id) VALUES(?,?,?)
      ON CONFLICT(root_id) DO UPDATE SET session_id=excluded.session_id
      WHERE conversations.latest_id=excluded.latest_id
        AND (conversations.session_id IS NULL OR conversations.session_id=excluded.session_id)`).run(root, id, sessionId);
  }
  setTaskSession(id: string, sessionId: string): void {
    this.dependencies.transaction(() => this.captureSession(id, sessionId));
  }
  findContinuation(id: string, input: ContinueTask): { task: Task; created: false } | null {
    const parent = this.dependencies.getTask(id);
    if (parent.instructions && input.instructions === undefined) throw new RunnerError('invalid_input');
    if (input.launch !== undefined) parseLaunchOptions(input.launch, parent.provider);
    const previous = this.db.prepare('SELECT sequence,payload,fingerprint FROM tasks WHERE key=?').get(input.idempotencyKey);
    if (!previous) return null;
    if (previous['fingerprint'] !== this.continuationFingerprint(id, input)) throw new RunnerError('conflict');
    return { task: { ...JSON.parse(previous['payload'] as string) as Task, sequence: Number(previous['sequence']) }, created: false };
  }
  private continuationFingerprint(id: string, input: ContinueTask): string {
    const parts = input.parts.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'attachment', attachmentId: part.attachmentId });
    return JSON.stringify({ ...(input.instructions === undefined ? {} : { instructions: parseInstructionSnapshot(input.instructions) }), parentTaskId: id, parts, ...(input.launch === undefined ? {} : { launch: parseLaunchOptions(input.launch) }) });
  }
  continueTask(id: string, input: ContinueTask): { task: Task; created: boolean } {
    return this.dependencies.transaction(() => this.admitContinuation(id, input));
  }
  /** Caller owns the SQLite transaction; used for atomic pending-message promotion. */
  admitContinuation(id: string, input: ContinueTask): { task: Task; created: boolean } {
    const fingerprint = this.continuationFingerprint(id, input);
      const parent = this.dependencies.getTask(id);
      const launch = input.launch === undefined ? parent.launch : parseLaunchOptions(input.launch, parent.provider);
      const previous = this.findContinuation(id, input);
      if (previous) return previous;
      if (!this.getResumeState(id).available) throw new RunnerError('conflict');
      this.dependencies.requireCapacity();
      const refs = [...new Set(input.parts.flatMap(part => part.type === 'attachment' ? [part.attachmentId] : []))];
      for (const ref of refs) this.dependencies.getAttachment(ref);
      const root = parent.conversationId ?? parent.id;
      const task: Task = { ...(parent.isolation === undefined ? {} : { isolation: parent.isolation }), ...(input.instructions === undefined ? {} : { instructions: parseInstructionSnapshot(input.instructions) }), id: randomUUID(), sequence: 0, runnerId: parent.runnerId, provider: parent.provider, projectId: parent.projectId!, conversationId: root, parentTaskId: id, status: 'queued', ...(launch ? { launch } : {}), parts: input.parts, createdAt: new Date().toISOString() };
      const result = this.db.prepare('INSERT INTO tasks(id,key,fingerprint,payload) VALUES(?,?,?,?)').run(task.id, input.idempotencyKey, fingerprint, JSON.stringify(task));
      for (const ref of refs) this.db.prepare('INSERT INTO task_attachments VALUES(?,?)').run(task.id, ref);
      this.db.prepare('INSERT INTO task_execution(task_id) VALUES(?)').run(task.id);
      this.db.prepare('UPDATE conversations SET latest_id=? WHERE root_id=? AND latest_id=?').run(task.id, root, id);
      this.dependencies.event(task.id, 'task.created');
      this.dependencies.event(task.id, 'task.queued');
      this.dependencies.wakeThread(root);
      this.dependencies.requireCapacity();
      return { task: { ...task, sequence: Number(result.lastInsertRowid) }, created: true };
  }
}
