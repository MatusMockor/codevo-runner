import type { DatabaseSync } from 'node:sqlite';
import { RunnerError, type Task } from '../../domain/contracts.js';
import { parseSteerInput } from '../../domain/steering.js';
import type { PendingMessage } from '../../domain/pending-message.js';
import type { SteerInput, SteerClaim, SteerReceipt } from '../../domain/steering.js';

export const STEERING_SCHEMA = `CREATE TABLE IF NOT EXISTS steering_messages (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), key TEXT UNIQUE NOT NULL,
 fingerprint TEXT NOT NULL, parts TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
 pending_id TEXT UNIQUE REFERENCES pending_messages(id)
);
CREATE INDEX IF NOT EXISTS steering_messages_task ON steering_messages(task_id);`;
type Dependencies = Readonly<{
 transaction<T>(action: () => T): T;
 getTask(id: string): Task;
 getAttachment(id: string): unknown;
 requireCapacity(): void;
}>;

/** A persisted claim is single use, including after an uncertain delivery or restart. */
export class SteeringDatabase {
 constructor(private readonly db: DatabaseSync, private readonly dependencies: Dependencies) {}
 private active(id: string): Task {
   const task = this.dependencies.getTask(id);
   const root = task.conversationId ?? task.id;
   const latest = this.db.prepare('SELECT latest_id FROM conversations WHERE root_id=?').get(root)?.['latest_id'] ?? root;
   if (task.status !== 'running' || latest !== id) throw new RunnerError('conflict');
   return task;
 }
 private claim(row: Record<string, unknown>): SteerClaim {
   if (row['accepted'] !== 1) throw new RunnerError('delivery_uncertain');
   return { taskId: row['task_id'] as string, messageId: row['id'] as string, parts: JSON.parse(row['parts'] as string) as SteerInput['parts'], accepted: true };
 }
 private fingerprint(id: string, input: SteerInput): string { return JSON.stringify({ taskId: id, parts: input.parts }); }
 findSteer(id: string, input: SteerInput): SteerReceipt | null {
   input = parseSteerInput(input);
   const row = this.db.prepare('SELECT * FROM steering_messages WHERE key=?').get(input.idempotencyKey);
   if (!row) return null;
   if (row['fingerprint'] !== this.fingerprint(id, input)) throw new RunnerError('conflict');
   const claim = this.claim(row);
   return { taskId: claim.taskId, messageId: claim.messageId, status: 'accepted' };
 }
 findPendingSteer(id: string, pendingId: string): SteerReceipt | null {
   const row = this.db.prepare('SELECT * FROM steering_messages WHERE pending_id=?').get(pendingId);
   if (!row) return null;
   if (row['task_id'] !== id) throw new RunnerError('conflict');
   const claim = this.claim(row);
   return { taskId: claim.taskId, messageId: claim.messageId, status: 'accepted' };
 }
 private insert(id: string, input: SteerInput, pendingId: string | null): SteerClaim {
   this.dependencies.requireCapacity();
   const total = Number(this.db.prepare('SELECT count(*) AS n FROM steering_messages').get()!['n']);
   const count = Number(this.db.prepare('SELECT count(*) AS n FROM steering_messages WHERE task_id=?').get(id)!['n']);
   if (total >= 1000 || count >= 32) throw new RunnerError('quota_exceeded');
   for (const part of input.parts) if (part.type === 'attachment') this.dependencies.getAttachment(part.attachmentId);
   const messageId = pendingId ?? input.idempotencyKey;
   this.db.prepare('INSERT INTO steering_messages(id,task_id,key,fingerprint,parts,pending_id) VALUES(?,?,?,?,?,?)').run(messageId, id, input.idempotencyKey, this.fingerprint(id, input), JSON.stringify(input.parts), pendingId);
   this.dependencies.requireCapacity();
   return { taskId: id, messageId, parts: input.parts, accepted: false };
 }
 claimSteer(id: string, input: SteerInput): SteerClaim {
   input = parseSteerInput(input);
   return this.dependencies.transaction(() => {
     const previous = this.findSteer(id, input);
     if (previous) return { ...previous, parts: input.parts, accepted: true };
     this.active(id);
     return this.insert(id, input, null);
   });
 }
 claimPendingSteer(id: string, pendingId?: string): SteerClaim | null {
   return this.dependencies.transaction(() => {
     if (pendingId) {
       const previous = this.findPendingSteer(id, pendingId);
       if (previous) return this.claim(this.db.prepare('SELECT * FROM steering_messages WHERE id=?').get(previous.messageId)!);
     }
     const task = this.active(id);
     const root = task.conversationId ?? id;
     const paused = this.db.prepare('SELECT paused FROM pending_queues WHERE root_id=?').get(root)?.['paused'] === 1;
     if (paused) { if (pendingId) throw new RunnerError('conflict'); return null; }
     const row = pendingId
       ? this.db.prepare('SELECT payload,dispatch_key FROM pending_messages WHERE root_id=? AND id=?').get(root, pendingId)
       : this.db.prepare("SELECT payload,dispatch_key FROM pending_messages WHERE root_id=? AND json_extract(payload,'$.status')='queued' AND id NOT IN (SELECT pending_id FROM steering_messages WHERE pending_id IS NOT NULL) ORDER BY sequence LIMIT 1").get(root);
     if (!row) { if (pendingId) throw new RunnerError('not_found'); return null; }
     const pending = JSON.parse(row['payload'] as string) as PendingMessage;
     if (pending.status !== 'queued') throw new RunnerError('conflict');
     if (JSON.stringify(pending.launch) !== JSON.stringify(task.launch) || JSON.stringify(pending.instructions) !== JSON.stringify(task.instructions)) {
       if (pendingId) throw new RunnerError('conflict');
       return null;
     }
     const claim = this.insert(id, { idempotencyKey: row['dispatch_key'] as string, parts: pending.parts }, pending.id);
     return claim;
   });
 }
 releaseSteer(id: string, messageId: string): void {
   this.dependencies.transaction(() => {
     const row = this.db.prepare('SELECT accepted FROM steering_messages WHERE task_id=? AND id=?').get(id, messageId);
     if (!row) return;
     if (row['accepted'] === 1) throw new RunnerError('conflict');
     this.db.prepare('DELETE FROM steering_messages WHERE task_id=? AND id=? AND accepted=0').run(id, messageId);
   });
 }
 acceptSteer(id: string, messageId: string): SteerReceipt {
   return this.dependencies.transaction(() => {
     const row = this.db.prepare('SELECT * FROM steering_messages WHERE task_id=? AND id=?').get(id, messageId);
     if (!row) throw new RunnerError('not_found');
     if (row['accepted'] !== 1) this.db.prepare('INSERT INTO events(task_id,type,created_at,data) VALUES(?,?,?,?)').run(id, 'task.input', new Date().toISOString(), JSON.stringify({ messageId, parts: JSON.parse(row['parts'] as string) as SteerInput['parts'] }));
     this.db.prepare('UPDATE steering_messages SET accepted=1 WHERE id=?').run(messageId);
     if (row['pending_id']) {
       const pending = JSON.parse(this.db.prepare('SELECT payload FROM pending_messages WHERE id=?').get(row['pending_id'] as string)!['payload'] as string) as PendingMessage;
       this.db.prepare('UPDATE pending_messages SET payload=? WHERE id=?').run(JSON.stringify({ ...pending, status: 'dispatched', taskId: id }), pending.id);
     }
     return { taskId: id, messageId, status: 'accepted' };
   });
 }
}
