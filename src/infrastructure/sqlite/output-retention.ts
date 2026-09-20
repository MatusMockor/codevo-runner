import type { DatabaseSync } from 'node:sqlite';
import type { EventPage } from '../../domain/contracts.js';

/** Only physical free-space headroom and individual error payloads are bounded. */
export const SQLITE_EXECUTION_STORAGE = Object.freeze({ reserveBytes: 16 * 1024 * 1024, errorBytes: 1024 });

/** Preserve legacy loss evidence. New output is durable and never automatically evicted. */
export function outputRetentionMetadata(db: DatabaseSync, taskId: string): Pick<EventPage, 'outputTruncatedBeforeSequence' | 'outputStartsAtLineBoundary'> {
  const row = db.prepare('SELECT output_truncated_before_sequence,output_starts_at_line_boundary FROM task_execution WHERE task_id=?').get(taskId);
  const watermark = Number(row?.['output_truncated_before_sequence'] ?? 0);
  return watermark > 0 ? { outputTruncatedBeforeSequence: watermark, outputStartsAtLineBoundary: row?.['output_starts_at_line_boundary'] === 1 } : {};
}
