import type { DatabaseSync } from 'node:sqlite';
import { RunnerError, type Task } from '../../domain/contracts.js';
import { parseThreadOrder, threadSection, type ThreadOrder, defaultThreadMetadata, metadataTaskId, parseThreadMetadataPatch, type ThreadMetadata, type ThreadMetadataPage, type ThreadMetadataPatch } from '../../domain/thread-metadata.js';
export const THREAD_METADATA_SCHEMA = `CREATE TABLE IF NOT EXISTS thread_metadata (task_id TEXT PRIMARY KEY REFERENCES tasks(id), payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_thread_roots_project ON tasks(json_extract(payload,'$.projectId')) WHERE json_extract(payload,'$.conversationId') IS NULL;`;
export class ThreadMetadataDatabase {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T, private readonly getTask: (id: string) => Task, private readonly requireCapacity: () => void) {}
  private root(id: string): string { const task = this.getTask(metadataTaskId(id)); return task.conversationId ?? task.id; }
  get(id: string): ThreadMetadata {
    const root = this.root(id);
    const row = this.db.prepare('SELECT payload FROM thread_metadata WHERE task_id=?').get(root);
    return row ? JSON.parse(row['payload'] as string) as ThreadMetadata : defaultThreadMetadata(root);
  }
  list(after: string): ThreadMetadataPage {
    if (after !== '') metadataTaskId(after);
    const rows = this.db.prepare('SELECT task_id,payload FROM thread_metadata WHERE task_id>? ORDER BY task_id LIMIT 101').all(after);
    const items = rows.slice(0, 100).map(row => JSON.parse(row['payload'] as string) as ThreadMetadata);
    return { items, nextAfter: rows.length > 100 ? items.at(-1)!.taskId : null };
  }
  /** Caller owns the admission transaction; failed admission rolls this write back. */
  wake(id: string): void {
    const current = this.get(id);
    if (current.settledAt === null && current.snoozedUntil === null) return;
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new RunnerError('quota_exceeded');
    const next = { ...current, revision: current.revision + 1, settledAt: null, snoozedUntil: null };
    this.db.prepare('UPDATE thread_metadata SET payload=? WHERE task_id=?').run(JSON.stringify(next), current.taskId);
  }
  reorder(id: string, input: ThreadOrder): { items: readonly ThreadMetadata[] } {
    const order = parseThreadOrder(input);
    return this.transaction(() => {
      const current = this.get(id);
      const target = this.get(order.targetTaskId);
      const project = this.getTask(current.taskId).projectId;
      const now = Date.now();
      const section = threadSection(current, now);
      if (!project || this.getTask(target.taskId).projectId !== project || current.removed || target.removed || section === 'archived' || threadSection(target, now) !== section) throw new RunnerError('conflict');
      if (current.taskId === target.taskId) return { items: [] };
      // Project-root inventory is bounded before sorting or creating a write set.
      const rows = this.db.prepare(`SELECT t.id, json_extract(coalesce(latest.payload,t.payload),'$.createdAt') AS updated_at FROM tasks t
        LEFT JOIN conversations c ON c.root_id=t.id LEFT JOIN tasks latest ON latest.id=c.latest_id
        LEFT JOIN thread_metadata m ON m.task_id=t.id
        WHERE json_extract(t.payload,'$.projectId')=? AND json_extract(t.payload,'$.conversationId') IS NULL
        AND coalesce(json_extract(m.payload,'$.removed'),0)=0
        AND (CASE WHEN coalesce(json_extract(m.payload,'$.archived'),0)=1 THEN 'archived'
          WHEN json_extract(m.payload,'$.settledAt') IS NOT NULL THEN 'settled'
          WHEN json_extract(m.payload,'$.snoozedUntil')>? THEN 'snoozed'
          WHEN coalesce(json_extract(m.payload,'$.pinned'),0)=1 THEN 'pinned' ELSE 'active' END)=? LIMIT 257`).all(project, now, section);
      if (rows.length > 256) throw new RunnerError('quota_exceeded');
      const siblings = rows.map(row => ({ metadata: this.get(row['id'] as string), updatedAt: row['updated_at'] as string }))
        .filter(row => !row.metadata.removed && threadSection(row.metadata, now) === section)
        .sort((a, b) => (a.metadata.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.metadata.sortOrder ?? Number.MAX_SAFE_INTEGER) || b.updatedAt.localeCompare(a.updatedAt) || a.metadata.taskId.localeCompare(b.metadata.taskId));
      const without = siblings.filter(row => row.metadata.taskId !== current.taskId);
      const position = without.findIndex(row => row.metadata.taskId === target.taskId);
      if (position < 0) throw new RunnerError('conflict');
      without.splice(position + (order.placement === 'after' ? 1 : 0), 0, { metadata: current, updatedAt: '' });
      this.requireCapacity();
      const items: ThreadMetadata[] = [];
      for (const [sortOrder, row] of without.entries()) {
        if (row.metadata.sortOrder === sortOrder) continue;
        if (row.metadata.revision >= Number.MAX_SAFE_INTEGER) throw new RunnerError('quota_exceeded');
        const next = { ...row.metadata, sortOrder, revision: row.metadata.revision + 1 };
        this.db.prepare('INSERT INTO thread_metadata(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(next.taskId, JSON.stringify(next));
        items.push(next);
      }
      return { items };
    });
  }
  patch(id: string, input: ThreadMetadataPatch): ThreadMetadata {
    const patch = parseThreadMetadataPatch(input);
    return this.transaction(() => {
      const current = this.get(id);
      if (current.revision !== patch.expectedRevision) throw new RunnerError('conflict');
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new RunnerError('quota_exceeded');
      this.requireCapacity();
      const { expectedRevision: _, ...fields } = patch;
      const next = { ...current, ...fields, revision: current.revision + 1 };
      if (next.snoozedUntil !== null && next.settledAt !== null) throw new RunnerError('invalid_input');
      this.db.prepare('INSERT INTO thread_metadata(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(current.taskId, JSON.stringify(next));
      return next;
    });
  }
}
