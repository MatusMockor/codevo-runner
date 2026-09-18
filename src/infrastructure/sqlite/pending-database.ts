import { STEERING_SCHEMA } from './steering-database.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RunnerError, type Task } from '../../domain/contracts.js';
import { parseLaunchOptions } from '../../domain/launch.js';
import { parseContinueTask, type ContinueTask, type ResumeState } from '../../domain/task-resume.js';
import { PENDING_LIMITS, type PendingMessage, type PendingMessages } from '../../domain/pending-message.js';

export const PENDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_queues (
 root_id TEXT PRIMARY KEY REFERENCES tasks(id), paused INTEGER NOT NULL DEFAULT 0,
 allow_terminal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_messages (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 root_id TEXT NOT NULL REFERENCES pending_queues(root_id), key TEXT UNIQUE NOT NULL,
 fingerprint TEXT NOT NULL, dispatch_key TEXT UNIQUE NOT NULL,
 payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_messages_root ON pending_messages(root_id, sequence);
CREATE TABLE IF NOT EXISTS pending_attachments (
 pending_id TEXT NOT NULL REFERENCES pending_messages(id),
 attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(pending_id, attachment_id)
);
${STEERING_SCHEMA}`;

type Dependencies = Readonly<{
 transaction<T>(action: () => T): T;
 getTask(id: string): Task;
 requireCapacity(): void;
 getAttachment(id: string): unknown;
 resumeState(id: string): ResumeState;
 continueTask(id: string, input: ContinueTask): { task: Task; created: boolean };
}>;

/** Durable queue state never replaces the currently running turn's session authority. */
export class PendingDatabase {
 constructor(private readonly db: DatabaseSync, private readonly dependencies: Dependencies) {}
 private root(id: string): string {
   const task = this.dependencies.getTask(id);
   if (!task.projectId || task.status === 'draft') throw new RunnerError('conflict');
   return task.conversationId ?? task.id;
 }
 private latest(root: string): Task {
   const row = this.db.prepare('SELECT latest_id FROM conversations WHERE root_id=?').get(root);
   return this.dependencies.getTask(row?.['latest_id'] as string ?? root);
 }
 private record(row: Record<string, unknown>): PendingMessage {
   const value = JSON.parse(row['payload'] as string) as PendingMessage;
   const steering = this.db.prepare('SELECT accepted FROM steering_messages WHERE pending_id=?').get(value.id);
   if (value.status === 'queued' && steering?.['accepted'] === 0) return { ...value, status: 'uncertain' };
   const queue = this.db.prepare('SELECT paused FROM pending_queues WHERE root_id=?').get(value.conversationId);
   return value.status === 'queued' && queue?.['paused'] === 1 ? { ...value, status: 'paused' } : value;
 }
 listPending(id: string): PendingMessages {
   const root = this.root(id);
   const rows = this.db.prepare("SELECT payload FROM pending_messages WHERE root_id=? AND json_extract(payload,'$.status')='queued' ORDER BY sequence LIMIT ?").all(root, PENDING_LIMITS.perConversation);
   return { items: rows.map(row => this.record(row)) };
 }
 enqueuePending(id: string, input: ContinueTask): { pending: PendingMessage; created: boolean } {
   input = parseContinueTask(input);
   return this.dependencies.transaction(() => {
     const root = this.root(id);
     const latest = this.latest(root);
     const launch = input.launch === undefined ? latest.launch : parseLaunchOptions(input.launch, latest.provider);
     const fingerprint = JSON.stringify({ ...(input.instructions ? { instructions: input.instructions } : {}), root, parts: input.parts, ...(input.launch ? { launch: input.launch } : {}) });
     const previous = this.db.prepare('SELECT payload,fingerprint FROM pending_messages WHERE key=?').get(input.idempotencyKey);
     if (previous) {
       if (previous['fingerprint'] !== fingerprint) throw new RunnerError('conflict');
       return { pending: this.record(previous), created: false };
     }
     if (latest.instructions && input.instructions === undefined) throw new RunnerError('invalid_input');
     this.dependencies.requireCapacity();
     const count = Number(this.db.prepare('SELECT count(*) AS n FROM pending_messages').get()!['n']);
     if (count >= PENDING_LIMITS.retained || this.listPending(id).items.length >= PENDING_LIMITS.perConversation) throw new RunnerError('quota_exceeded');
     const refs = [...new Set(input.parts.flatMap(part => part.type === 'attachment' ? [part.attachmentId] : []))];
     for (const ref of refs) this.dependencies.getAttachment(ref);
     const paused = ['failed', 'cancelled', 'interrupted'].includes(latest.status) ? 1 : 0;
     this.db.prepare('INSERT INTO pending_queues(root_id,paused) VALUES(?,?) ON CONFLICT(root_id) DO UPDATE SET paused=max(paused,excluded.paused)').run(root, paused);
     const pending: PendingMessage = { ...(input.instructions ? { instructions: input.instructions } : {}), id: randomUUID(), conversationId: root, status: 'queued', parts: input.parts, ...(launch ? { launch } : {}), createdAt: new Date().toISOString(), taskId: null };
     this.db.prepare('INSERT INTO pending_messages(id,root_id,key,fingerprint,dispatch_key,payload) VALUES(?,?,?,?,?,?)').run(pending.id, root, input.idempotencyKey, fingerprint, randomUUID(), JSON.stringify(pending));
     for (const ref of refs) this.db.prepare('INSERT INTO pending_attachments VALUES(?,?)').run(pending.id, ref);
     this.dependencies.requireCapacity();
     return { pending: this.record({ payload: JSON.stringify(pending) }), created: true };
   });
 }
 removePending(id: string, pendingId: string): PendingMessage {
   return this.dependencies.transaction(() => {
     const task = this.dependencies.getTask(id);
     const root = task.conversationId ?? task.id;
     const row = this.db.prepare('SELECT payload FROM pending_messages WHERE id=? AND root_id=?').get(pendingId, root);
     if (!row) throw new RunnerError('not_found');
     const current = this.record(row);
     if (current.status === 'dispatched') throw new RunnerError('conflict');
     const pending: PendingMessage = { ...current, status: 'cancelled' };
     this.db.prepare('UPDATE pending_messages SET payload=? WHERE id=?').run(JSON.stringify(pending), pendingId);
     return pending;
   });
 }
 resumePending(id: string): PendingMessages {
   return this.dependencies.transaction(() => {
     const root = this.root(id);
     const latest = this.latest(root);
     if (!this.dependencies.resumeState(latest.id).available) throw new RunnerError('conflict');
     this.db.prepare('UPDATE pending_queues SET paused=0,allow_terminal=1 WHERE root_id=?').run(root);
     return this.listPending(id);
   });
 }
 /** Caller already owns the task transition's transaction. */
 pauseTask(id: string): void {
   const task = this.dependencies.getTask(id);
   this.db.prepare('UPDATE pending_queues SET paused=1,allow_terminal=0 WHERE root_id=?').run(task.conversationId ?? task.id);
 }
 pauseAll(): void { this.db.prepare('UPDATE pending_queues SET paused=1,allow_terminal=0').run(); }
 promotePending(): Task | null {
   return this.dependencies.transaction(() => {
     const queues = this.db.prepare(`SELECT q.root_id,q.allow_terminal FROM pending_queues q
       WHERE q.paused=0 AND EXISTS(SELECT 1 FROM pending_messages m WHERE m.root_id=q.root_id AND json_extract(m.payload,'$.status')='queued' AND m.id NOT IN (SELECT pending_id FROM steering_messages WHERE pending_id IS NOT NULL))
       ORDER BY (SELECT min(sequence) FROM pending_messages m WHERE m.root_id=q.root_id AND json_extract(m.payload,'$.status')='queued' AND m.id NOT IN (SELECT pending_id FROM steering_messages WHERE pending_id IS NOT NULL)) LIMIT ?`).all(PENDING_LIMITS.retained);
     for (const queue of queues) {
       const root = queue['root_id'] as string;
       const latest = this.latest(root);
       if (['queued', 'running'].includes(latest.status)) continue;
       if ((latest.status !== 'succeeded' && queue['allow_terminal'] !== 1) || !this.dependencies.resumeState(latest.id).available) {
         this.pauseTask(latest.id); continue;
       }
       const row = this.db.prepare("SELECT payload,dispatch_key FROM pending_messages WHERE root_id=? AND json_extract(payload,'$.status')='queued' AND id NOT IN (SELECT pending_id FROM steering_messages WHERE pending_id IS NOT NULL) ORDER BY sequence LIMIT 1").get(root)!;
       const pending = this.record(row);
       this.db.exec('SAVEPOINT pending_promotion');
       let result: { task: Task; created: boolean };
       try {
         result = this.dependencies.continueTask(latest.id, { idempotencyKey: row['dispatch_key'] as string, parts: pending.parts, ...(pending.instructions ? { instructions: pending.instructions } : {}), ...(pending.launch ? { launch: pending.launch } : {}) });
         this.db.exec('RELEASE pending_promotion');
       } catch (error) {
         this.db.exec('ROLLBACK TO pending_promotion; RELEASE pending_promotion');
         if (!(error instanceof RunnerError) || !['quota_exceeded', 'conflict', 'not_found'].includes(error.code)) throw error;
         this.pauseTask(latest.id);
         continue;
       }
       this.db.prepare('UPDATE pending_messages SET payload=? WHERE id=?').run(JSON.stringify({ ...pending, status: 'dispatched', taskId: result.task.id }), pending.id);
       this.db.prepare('UPDATE pending_queues SET allow_terminal=0 WHERE root_id=?').run(root);
       return result.task;
     }
     return null;
   });
 }
}
