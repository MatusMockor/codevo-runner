import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, RunnerError, type Attachment, type CreateTask, type Page, type Task, type TaskEvent } from '../../domain/contracts.js';

export class RepositoryDatabase {
  private readonly db!: DatabaseSync;
  private readonly lease!: DatabaseSync;
  constructor(dataDir: string, private readonly runnerId: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      this.lease = new DatabaseSync(join(dataDir, 'runner-lease.sqlite'));
      this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(join(dataDir, 'runner.sqlite'));
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA max_page_count=16384; PRAGMA journal_size_limit=4194304;');
      this.migrate();
    } catch (error) {
      try { this.db?.close(); } finally { this.lease?.close(); }
      throw error;
    }
  }
  private migrate(): void {
    this.transaction(() => {
      const version = this.db.prepare('PRAGMA user_version').get()!['user_version'];
      if (version !== 0 && version !== 1) throw new RunnerError('storage_unavailable');
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_attachments (task_id TEXT NOT NULL REFERENCES tasks(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(task_id, attachment_id));
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_task_sequence ON events(task_id, sequence);`);
      const identity = this.db.prepare("SELECT value FROM metadata WHERE key='runnerId'").get();
      if (identity && identity['value'] !== this.runnerId) throw new RunnerError('conflict');
      this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('runnerId',?)").run(this.runnerId);
      this.db.exec('PRAGMA user_version=1');
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
  private task(row: Record<string, unknown>): Task {
    return { ...JSON.parse(row['payload'] as string) as Task, sequence: Number(row['sequence']) };
  }
  getTask(id: string): Task {
    const row = this.db.prepare('SELECT sequence,payload FROM tasks WHERE id=?').get(id);
    if (!row) throw new RunnerError('not_found');
    return this.task(row);
  }
  createTask(input: CreateTask): { task: Task; created: boolean } {
    const normalized = { provider: input.provider, parts: input.parts.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'attachment', attachmentId: part.attachmentId }) };
    const fingerprint = JSON.stringify(normalized);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT sequence,payload,fingerprint FROM tasks WHERE key=?').get(input.idempotencyKey);
      if (previous) {
        if (previous['fingerprint'] !== fingerprint) throw new RunnerError('conflict');
        return { task: this.task(previous), created: false };
      }
      const refs = [...new Set(input.parts.flatMap(part => part.type === 'attachment' ? [part.attachmentId] : []))];
      for (const id of refs) this.getAttachment(id);
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM tasks').get()!['n']);
      if (count >= LIMITS.tasks) throw new RunnerError('quota_exceeded');
      const task: Task = { id: randomUUID(), sequence: 0, runnerId: this.runnerId, provider: input.provider, status: 'draft', parts: input.parts, createdAt: new Date().toISOString() };
      const result = this.db.prepare('INSERT INTO tasks(id,key,fingerprint,payload) VALUES(?,?,?,?)').run(task.id, input.idempotencyKey, fingerprint, JSON.stringify(task));
      for (const id of refs) this.db.prepare('INSERT INTO task_attachments VALUES(?,?)').run(task.id, id);
      this.event(task.id, 'task.created');
      return { task: { ...task, sequence: Number(result.lastInsertRowid) }, created: true };
    });
  }
  private event(id: string, type: TaskEvent['type']): void {
    this.db.prepare('INSERT INTO events(task_id,type,created_at) VALUES(?,?,?)').run(id, type, new Date().toISOString());
  }
  cancelTask(id: string): Task {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (task.status === 'cancelled') return task;
      const cancelled: Task = { ...task, status: 'cancelled' };
      this.db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(cancelled), id);
      this.event(id, 'task.cancelled');
      return cancelled;
    });
  }
  private page<T extends { sequence: number }>(rows: T[]): Page<T> {
    const items = rows.slice(0, LIMITS.pageSize);
    return { items, nextCursor: rows.length > LIMITS.pageSize ? items.at(-1)!.sequence : null };
  }
  listTasks(after: number): Page<Task> {
    return this.page(this.db.prepare('SELECT sequence,payload FROM tasks WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, LIMITS.pageSize + 1).map(row => this.task(row)));
  }
  listEvents(taskId: string, after: number): Page<TaskEvent> {
    this.getTask(taskId);
    return this.page(this.db.prepare('SELECT sequence,task_id,type,created_at FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(taskId, after, LIMITS.pageSize + 1).map(row => ({ sequence: Number(row['sequence']), taskId: row['task_id'] as string, type: row['type'] as TaskEvent['type'], createdAt: row['created_at'] as string })));
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
      this.db.prepare('INSERT INTO attachments VALUES(?,?,?)').run(value.id, JSON.stringify(value), value.bytes);
      return { attachment: value, created: true };
    });
  }
  close(): void {
    try { this.db.close(); } finally { this.lease.close(); }
  }
}
