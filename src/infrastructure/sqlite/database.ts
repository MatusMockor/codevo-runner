import { parseAgentSubagentLifecycle, readAgentSubagentLifecycle, type AgentSubagentLifecycle } from '../../domain/subagent-lifecycle.js';
import { SteeringDatabase } from './steering-database.js';
import { QuestionDatabase, QUESTION_SCHEMA } from './question-database.js';
import { outputRetentionMetadata, SQLITE_EXECUTION_STORAGE } from './output-retention.js';
export { SQLITE_EXECUTION_STORAGE } from './output-retention.js';
import { parseInstructionSnapshot } from '../../domain/instructions.js';
import { ArtifactDatabase, ARTIFACT_SCHEMA } from './artifact-database.js';
import { PendingDatabase, PENDING_SCHEMA } from './pending-database.js';
import { searchHistory } from './history-search.js';
import type { HistorySearchQuery, HistorySearchPage } from '../../domain/history-search.js';
import { parseLaunchOptions } from '../../domain/launch.js';
import { ResumeDatabase, RESUME_SCHEMA } from './resume-database.js';
import type { ContinueTask, ResumeState } from '../../domain/task-resume.js';
import { CloneDatabase, CLONE_SCHEMA } from './clone-database.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, RunnerError, type Attachment, type CreateTask, type EventPage, type Page, type Task, type TaskEvent } from '../../domain/contracts.js';

import { EXECUTION_LIMITS, type ExecutionResult, type OutputChannel } from '../../domain/execution.js';



export class RepositoryDatabase {
  private readonly db!: DatabaseSync;
  private readonly lease!: DatabaseSync;
  readonly questions: QuestionDatabase;
  readonly artifacts: ArtifactDatabase;
  readonly clones: CloneDatabase;
  readonly resumes: ResumeDatabase;
  readonly pending: PendingDatabase;
  readonly steering: SteeringDatabase;
  constructor(private readonly dataDir: string, private readonly runnerId: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      this.lease = new DatabaseSync(join(dataDir, 'runner-lease.sqlite'));
      this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(join(dataDir, 'runner.sqlite'));
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA max_page_count=4294967294; PRAGMA journal_size_limit=4194304;');
      this.migrate();
      this.questions = new QuestionDatabase(this.db, action => this.transaction(action), id => this.getTask(id), () => this.requireBulkCapacity());
      this.artifacts = new ArtifactDatabase(this.db, action => this.transaction(action), id => this.getTask(id), () => this.requireBulkCapacity());
      this.resumes = new ResumeDatabase(this.db, { transaction: action => this.transaction(action), getTask: id => this.getTask(id), requireCapacity: () => this.requireBulkCapacity(), getAttachment: id => this.getAttachment(id), event: (id, type) => this.event(id, type) });
      this.pending = new PendingDatabase(this.db, { transaction: action => this.transaction(action), getTask: id => this.getTask(id), requireCapacity: () => this.requireBulkCapacity(), getAttachment: id => this.getAttachment(id), resumeState: id => this.resumes.getResumeState(id), continueTask: (id, input) => this.resumes.admitContinuation(id, input) });
      this.steering = new SteeringDatabase(this.db, { transaction: action => this.transaction(action), getTask: id => this.getTask(id), requireCapacity: () => this.requireBulkCapacity(), getAttachment: id => this.getAttachment(id) });
      this.clones = new CloneDatabase(this.db, action => this.transaction(action), () => this.requireBulkCapacity());
    } catch (error) {
      try { this.db?.close(); } finally { this.lease?.close(); }
      throw error;
    }
  }
  private migrate(): void {
    this.transaction(() => {
      const version = this.db.prepare('PRAGMA user_version').get()!['user_version'];
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8) throw new RunnerError('storage_unavailable');
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_attachments (task_id TEXT NOT NULL REFERENCES tasks(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(task_id, attachment_id));
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_task_sequence ON events(task_id, sequence);`);
      const identity = this.db.prepare("SELECT value FROM metadata WHERE key='runnerId'").get();
      if (identity && identity['value'] !== this.runnerId) throw new RunnerError('conflict');
      this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('runnerId',?)").run(this.runnerId);
      if (version === 0 || version === 1) this.db.exec('ALTER TABLE events ADD COLUMN data TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_execution (task_id TEXT PRIMARY KEY REFERENCES tasks(id), output_bytes INTEGER NOT NULL DEFAULT 0, output_events INTEGER NOT NULL DEFAULT 0);
        PRAGMA user_version=8;`);
      if (!this.db.prepare('PRAGMA table_info(task_execution)').all().some(column => column['name'] === 'output_truncated_before_sequence')) this.db.exec(`ALTER TABLE task_execution ADD COLUMN output_truncated_before_sequence INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_execution ADD COLUMN output_starts_at_line_boundary INTEGER NOT NULL DEFAULT 1;`);
      this.db.exec(CLONE_SCHEMA);
      this.db.exec(RESUME_SCHEMA);
      this.db.exec(PENDING_SCHEMA);
      this.db.exec(ARTIFACT_SCHEMA);
      this.db.exec(QUESTION_SCHEMA);
      this.db.exec("CREATE INDEX IF NOT EXISTS tasks_status_sequence ON tasks(json_extract(payload,'$.status'),sequence)");
      this.db.exec('CREATE TABLE IF NOT EXISTS task_subagents (task_id TEXT PRIMARY KEY REFERENCES tasks(id), payload TEXT NOT NULL)');
    });
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      // SQLITE_FULL can automatically roll back the transaction. Preserve its error.
      try { this.db.exec('ROLLBACK'); } catch { /* The original failure is authoritative. */ }
      throw error;
    }
  }
  private requireBulkCapacity(): void {
    // Capacity is available host storage, not a lifetime history quota. Retain a
    // small reserve for terminal state writes; real SQLite failures still propagate.
    const disk = statfsSync(this.dataDir, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(SQLITE_EXECUTION_STORAGE.reserveBytes)) throw new RunnerError('quota_exceeded');
    const exhausted = this.db.prepare('SELECT 1 FROM sqlite_sequence WHERE seq>=? LIMIT 1').get(Number.MAX_SAFE_INTEGER - 1024);
    if (exhausted) throw new RunnerError('quota_exceeded');
  }
  private task(row: Record<string, unknown>): Task {
    return { ...JSON.parse(row['payload'] as string) as Task, sequence: Number(row['sequence']) };
  }
  searchHistory(query: HistorySearchQuery): HistorySearchPage { return searchHistory(this.db, query); }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT sequence,payload FROM tasks WHERE id=?').get(id);
    if (!row) throw new RunnerError('not_found');
    return this.task(row);
  }
  getTaskSession(id: string): { sessionId: string | null; workspaceTaskId: string } { return this.resumes.getTaskSession(id); }
  getResumeState(id: string): ResumeState { return this.resumes.getResumeState(id); }
  findContinuation(id: string, input: ContinueTask): { task: Task; created: false } | null { return this.resumes.findContinuation(id, input); }
  continueTask(id: string, input: ContinueTask): { task: Task; created: boolean } { return this.resumes.continueTask(id, input); }
  setTaskSession(id: string, sessionId: string): void { this.resumes.setTaskSession(id, sessionId); }
  createTask(input: CreateTask): { task: Task; created: boolean } {
    if (input.isolation !== undefined && input.isolation !== 'in-place' && input.isolation !== 'worktree') throw new RunnerError('invalid_input');
    const isolation = input.isolation === undefined ? {} : { isolation: input.isolation };
    const instructions = input.instructions === undefined ? undefined : parseInstructionSnapshot(input.instructions);
    const launch = input.launch === undefined ? undefined : parseLaunchOptions(input.launch, input.provider);
    const normalized = { ...isolation, ...(instructions ? { instructions } : {}), ...(launch ? { launch } : {}), provider: input.provider, parts: input.parts.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'attachment', attachmentId: part.attachmentId }) };
    const fingerprint = JSON.stringify(normalized);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT sequence,payload,fingerprint FROM tasks WHERE key=?').get(input.idempotencyKey);
      if (previous) {
        if (previous['fingerprint'] !== fingerprint) throw new RunnerError('conflict');
        return { task: this.task(previous), created: false };
      }
      this.requireBulkCapacity();
      const refs = [...new Set(input.parts.flatMap(part => part.type === 'attachment' ? [part.attachmentId] : []))];
      for (const id of refs) this.getAttachment(id);
      const task: Task = { ...isolation, ...(instructions ? { instructions } : {}), id: randomUUID(), sequence: 0, runnerId: this.runnerId, provider: input.provider, status: 'draft', ...(launch ? { launch } : {}), parts: input.parts, createdAt: new Date().toISOString() };
      const result = this.db.prepare('INSERT INTO tasks(id,key,fingerprint,payload) VALUES(?,?,?,?)').run(task.id, input.idempotencyKey, fingerprint, JSON.stringify(task));
      for (const id of refs) this.db.prepare('INSERT INTO task_attachments VALUES(?,?)').run(task.id, id);
      this.event(task.id, 'task.created');
      this.requireBulkCapacity();
      return { task: { ...task, sequence: Number(result.lastInsertRowid) }, created: true };
    });
  }
  private event(id: string, type: TaskEvent['type'], data?: object): void {
    this.db.prepare('INSERT INTO events(task_id,type,created_at,data) VALUES(?,?,?,?)').run(id, type, new Date().toISOString(), data ? JSON.stringify(data) : null);
  }
  private save(task: Task, event: TaskEvent['type'], data?: object): Task {
    this.db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
    this.event(task.id, event, data);
    return task;
  }
  cancelTask(id: string): Task {
    return this.transaction(() => {
      const task = this.getTask(id);
      this.pending.pauseTask(id);
      this.questions.settlePending(id, 'cancelled');
      if (!['draft', 'queued', 'running'].includes(task.status)) return task;
      return this.save({ ...task, status: 'cancelled' }, 'task.cancelled');
    });
  }
  queueTask(id: string, projectId: string): Task {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (task.projectId === projectId && task.status !== 'draft') return task;
      if (task.status !== 'draft') throw new RunnerError('conflict');
      if (!projectId || projectId.length > 128) throw new RunnerError('invalid_input');
      this.db.prepare('INSERT INTO task_execution(task_id) VALUES(?)').run(id);
      return this.save({ ...task, projectId, status: 'queued' }, 'task.queued');
    });
  }
  claimNextTask(): Task | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT sequence,payload FROM tasks WHERE json_extract(payload,'$.status')='queued' ORDER BY sequence LIMIT 1").get();
      if (!row) return null;
      return this.save({ ...this.task(row), status: 'running' }, 'task.running');
    });
  }
  appendTaskOutput(id: string, channel: OutputChannel, text: string): void {
    if (channel !== 'stdout' && channel !== 'stderr') throw new RunnerError('invalid_input');
    this.transaction(() => {
      if (this.getTask(id).status !== 'running' || !text) return;
      if (Buffer.byteLength(text) > EXECUTION_LIMITS.outputEventBytes) throw new RunnerError('quota_exceeded');
      const output = text;
      this.requireBulkCapacity();
      this.event(id, 'task.output', { channel, text: output });
      const bytes = Buffer.byteLength(output);
      const updated = this.db.prepare('UPDATE task_execution SET output_bytes=output_bytes+?,output_events=output_events+1 WHERE task_id=? AND output_bytes<=? AND output_events<?').run(bytes, id, Number.MAX_SAFE_INTEGER - bytes, Number.MAX_SAFE_INTEGER);
      if (updated.changes !== 1) throw new RunnerError('quota_exceeded');
      this.requireBulkCapacity();
    });
  }
  finishTask(id: string, result: ExecutionResult): Task {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (result.sessionId) this.resumes.captureSession(id, result.sessionId);
      // Cancellation records intent before the worker has reaped its processes.
      // Only an actual cleanup failure may correct that terminal acknowledgement.
      const cleanupFailed = task.status === 'cancelled' && result.error === 'process_cleanup_failed'
        && this.db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='task.running' LIMIT 1").get(id);
      if (task.status !== 'running' && !cleanupFailed) return task;
      this.questions.settlePending(id, 'expired');
      const status = result.exitCode === 0 && !result.error ? 'succeeded' : 'failed';
      if (status === 'failed') this.pending.pauseTask(id);
      const data = { exitCode: result.exitCode, ...(result.error ? { error: boundedText(result.error, SQLITE_EXECUTION_STORAGE.errorBytes) } : {}) };
      return this.save({ ...task, status }, status === 'succeeded' ? 'task.succeeded' : 'task.failed', data);
    });
  }
  interruptRunningTasks(): void {
    this.transaction(() => {
      this.pending.pauseAll();
      this.questions.settlePending(undefined, 'expired');
      for (;;) {
        const rows = this.db.prepare("SELECT sequence,payload FROM tasks WHERE json_extract(payload,'$.status')='running' ORDER BY sequence LIMIT ?").all(LIMITS.pageSize);
        if (rows.length === 0) break;
        for (const row of rows) this.save({ ...this.task(row), status: 'interrupted' }, 'task.interrupted');
      }
    });
  }
  private page<T extends { sequence: number }>(rows: T[]): Page<T> {
    const items: T[] = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (items.length >= LIMITS.pageSize || (items.length > 0 && bytes + size > 3 * 1024 * 1024)) break;
      items.push(row); bytes += size;
    }
    return { items, nextCursor: rows.length > items.length ? items.at(-1)!.sequence : null };
  }
  listTasks(after: number): Page<Task> {
    return this.page(this.db.prepare('SELECT sequence,payload FROM tasks WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, LIMITS.pageSize + 1).map(row => this.task(row)));
  }
  setTaskSubagents(taskId: string, snapshot: AgentSubagentLifecycle): void {
    const parsed = parseAgentSubagentLifecycle(snapshot);
    if (!parsed) throw new RunnerError('invalid_input');
    this.transaction(() => {
      if (this.getTask(taskId).status !== 'running') return;
      this.requireBulkCapacity();
      this.db.prepare('INSERT INTO task_subagents(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(taskId, JSON.stringify(parsed));
    });
  }
  listEvents(taskId: string, after: number): EventPage {
    this.getTask(taskId);
    const rows = this.db.prepare('SELECT sequence,task_id,type,created_at,data FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(taskId, after, LIMITS.pageSize + 1);
    const items: TaskEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = { sequence: Number(row['sequence']), taskId: row['task_id'] as string, type: row['type'] as TaskEvent['type'], createdAt: row['created_at'] as string, ...(row['data'] ? JSON.parse(row['data'] as string) as object : {}) };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (items.length >= LIMITS.pageSize || (items.length > 0 && bytes + size > 3 * 1024 * 1024)) break;
      items.push(event); bytes += size;
    }
    const saved = this.db.prepare('SELECT payload FROM task_subagents WHERE task_id=?').get(taskId);
    const subagentLifecycle = readStoredLifecycle(saved?.['payload']);
    return { ...(subagentLifecycle ? { subagentLifecycle } : {}), ...outputRetentionMetadata(this.db, taskId), items, nextCursor: items.length < rows.length ? items.at(-1)!.sequence : null };
  }
  getAttachment(id: string): Attachment {
    const row = this.db.prepare('SELECT payload FROM attachments WHERE id=?').get(id);
    if (!row) throw new RunnerError('not_found');
    const value = JSON.parse(row['payload'] as string) as Attachment;
    if (value.runnerId !== this.runnerId) throw new RunnerError('not_found');
    return value;
  }
  putAttachment(value: Attachment): { attachment: Attachment; created: boolean } {
    return this.transaction(() => {
      if (value.runnerId !== this.runnerId) throw new RunnerError('conflict');
      const previous = this.db.prepare('SELECT payload FROM attachments WHERE id=?').get(value.id);
      if (previous) {
        const attachment = JSON.parse(previous['payload'] as string) as Attachment;
        const fields = ['id', 'runnerId', 'name', 'mediaType', 'bytes', 'sha256', 'width', 'height'] as const;
        if (fields.some(field => attachment[field] !== value[field])) throw new RunnerError('conflict');
        return { attachment, created: false };
      }
      const usage = this.db.prepare('SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM attachments').get()!;
      if (Number(usage['n']) >= LIMITS.attachments || Number(usage['bytes']) + value.bytes > LIMITS.storageBytes) throw new RunnerError('quota_exceeded');
      this.requireBulkCapacity();
      this.db.prepare('INSERT INTO attachments VALUES(?,?,?)').run(value.id, JSON.stringify(value), value.bytes);
      this.requireBulkCapacity();
      return { attachment: value, created: true };
    });
  }
  close(): void {
    try { this.db.close(); } finally { this.lease.close(); }
  }
}

/** A lifecycle written by an unknown version is dropped; the task stays readable. */
function readStoredLifecycle(payload: unknown): AgentSubagentLifecycle | undefined {
  if (typeof payload !== 'string') return undefined;
  try {
    return readAgentSubagentLifecycle(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

/** Truncate only at UTF-8 boundaries so stored byte limits remain exact. */
function boundedText(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString('utf8');
}
