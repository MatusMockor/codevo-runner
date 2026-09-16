import type { DatabaseSync } from 'node:sqlite';
import { EXECUTION_LIMITS } from '../../domain/execution.js';
import type { EventPage } from '../../domain/contracts.js';

/** Retained output is a rolling window; lifecycle records are never removed. */
export const SQLITE_EXECUTION_STORAGE = Object.freeze({ outputBytes: 8 * 1024 * 1024, outputEvents: 8192, reserveBytes: 16 * 1024 * 1024, errorBytes: 1024 });

/** Caller owns the transaction, including the new output insertion. */
export function retainOutputWindow(db: DatabaseSync, taskId: string): void {
  const usage = () => db.prepare('SELECT output_bytes AS bytes,output_events AS events FROM task_execution WHERE task_id=?').get(taskId)!;
  let task = usage();
  while (Number(task['bytes']) > EXECUTION_LIMITS.outputBytes || Number(task['events']) > EXECUTION_LIMITS.outputEvents) {
    evict(db, db.prepare("SELECT sequence,task_id,data FROM events WHERE task_id=? AND type='task.output' ORDER BY sequence LIMIT 1").get(taskId)!);
    task = usage();
  }
  const totals = () => db.prepare('SELECT coalesce(sum(output_bytes),0) AS bytes,coalesce(sum(output_events),0) AS events FROM task_execution').get()!;
  let total = totals();
  while (Number(total['bytes']) > SQLITE_EXECUTION_STORAGE.outputBytes || Number(total['events']) > SQLITE_EXECUTION_STORAGE.outputEvents) {
    // Keep at least the newest output record of each task, so every task retains some recent output. Historical final answers may age out.
    // At most 1000 tasks * 8192 bytes fit within the unchanged global byte budget.
    const oldest = db.prepare(`SELECT sequence,task_id,data FROM events e WHERE type='task.output'
      AND EXISTS (SELECT 1 FROM events n WHERE n.task_id=e.task_id AND n.type='task.output' AND n.sequence>e.sequence)
      ORDER BY sequence LIMIT 1`).get();
    if (!oldest) throw new Error('output_retention_invariant');
    evict(db, oldest);
    total = totals();
  }
}

function evict(db: DatabaseSync, row: Record<string, unknown>): void {
  const value = JSON.parse(row['data'] as string) as { channel: string; text: string };
  const boundary = value.channel === 'stdout' ? Number(value.text.endsWith('\n')) : null;
  db.prepare(`UPDATE task_execution SET output_bytes=output_bytes-?,output_events=output_events-1,
    output_truncated_before_sequence=max(output_truncated_before_sequence,?),
    output_starts_at_line_boundary=coalesce(?,output_starts_at_line_boundary) WHERE task_id=?`)
    .run(Buffer.byteLength(value.text), row['sequence'] as number, boundary, row['task_id'] as string);
  db.prepare('DELETE FROM events WHERE sequence=?').run(row['sequence'] as number);
}

export function outputRetentionMetadata(db: DatabaseSync, taskId: string): Pick<EventPage, 'outputTruncatedBeforeSequence' | 'outputStartsAtLineBoundary'> {
  const row = db.prepare('SELECT output_truncated_before_sequence,output_starts_at_line_boundary FROM task_execution WHERE task_id=?').get(taskId);
  const watermark = Number(row?.['output_truncated_before_sequence'] ?? 0);
  return watermark > 0 ? { outputTruncatedBeforeSequence: watermark, outputStartsAtLineBoundary: row?.['output_starts_at_line_boundary'] === 1 } : {};
}
