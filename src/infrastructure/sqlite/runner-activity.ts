import type { DatabaseSync } from 'node:sqlite';
import type { RunnerActivity } from '../../domain/maintenance.js';

export function readRunnerActivity(db: DatabaseSync): RunnerActivity {
  const row = db.prepare(`SELECT
    (SELECT count(*) FROM tasks WHERE json_extract(payload,'$.status') IN ('queued','running')) AS tasks,
    (SELECT count(*) FROM project_clones WHERE status IN ('queued','running')) AS clones,
    (SELECT count(*) FROM pending_messages WHERE json_extract(payload,'$.status')='queued') AS pending`).get()!;
  return { activeTasks: Number(row['tasks']), activeClones: Number(row['clones']), queuedPendingMessages: Number(row['pending']) };
}
