import type { DatabaseSync } from 'node:sqlite';
import { LIMITS, RunnerError, type Attachment } from '../../domain/contracts.js';

type Dependencies = Readonly<{
  runnerId: string;
  transaction<T>(action: () => T): T;
  requireCapacity(): void;
}>;
type Candidate = Readonly<{ id: string; bytes: number }>;
export type StoredAttachment = Readonly<{ attachment: Attachment; created: boolean; evicted?: readonly string[] }>;

const IDENTITY = ['id', 'runnerId', 'name', 'kind', 'mediaType', 'bytes', 'sha256', 'width', 'height'] as const;

export class AttachmentDatabase {
  constructor(private readonly db: DatabaseSync, private readonly dependencies: Dependencies) {}

  getAttachment(id: string): Attachment {
    const row = this.db.prepare('SELECT payload FROM attachments WHERE id=? AND bytes>0').get(id);
    if (!row) throw new RunnerError('not_found');
    const value = JSON.parse(row['payload'] as string) as Attachment;
    if (value.runnerId !== this.dependencies.runnerId) throw new RunnerError('not_found');
    return value;
  }

  putAttachment(value: Attachment): StoredAttachment {
    return this.dependencies.transaction(() => {
      if (value.runnerId !== this.dependencies.runnerId) throw new RunnerError('conflict');
      if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new RunnerError('invalid_input');
      const previous = this.db.prepare('SELECT payload,bytes FROM attachments WHERE id=?').get(value.id);
      if (previous && Number(previous['bytes']) > 0) {
        const attachment = JSON.parse(previous['payload'] as string) as Attachment;
        if (IDENTITY.some(field => attachment[field] !== value[field])) throw new RunnerError('conflict');
        return { attachment, created: false };
      }
      const evicted = this.makeRoom(value.bytes);
      this.dependencies.requireCapacity();
      if (previous) this.db.prepare('UPDATE attachments SET payload=?,bytes=? WHERE id=?').run(JSON.stringify(value), value.bytes, value.id);
      if (!previous) this.db.prepare('INSERT INTO attachments VALUES(?,?,?)').run(value.id, JSON.stringify(value), value.bytes);
      this.dependencies.requireCapacity();
      return { attachment: value, created: true, ...(evicted.length ? { evicted } : {}) };
    });
  }

  private makeRoom(incoming: number): readonly string[] {
    const usage = this.db.prepare('SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM attachments WHERE bytes>0').get()!;
    let count = Number(usage['n']);
    let bytes = Number(usage['bytes']);
    const fits = () => count < LIMITS.attachments && bytes + incoming <= LIMITS.storageBytes;
    if (fits()) return [];
    const evicted: string[] = [];
    for (const candidate of this.evictable()) {
      count--;
      bytes -= candidate.bytes;
      evicted.push(candidate.id);
      if (fits()) break;
    }
    if (!fits()) throw new RunnerError('quota_exceeded');
    for (const id of evicted) this.evict(id);
    return evicted;
  }

  private evictable(): readonly Candidate[] {
    const cutoff = new Date(Date.now() - LIMITS.attachmentEvictionGraceMs).toISOString();
    const pinned = this.pinned();
    return this.db.prepare("SELECT id,bytes,json_extract(payload,'$.createdAt') AS created FROM attachments WHERE bytes>0 ORDER BY created,id").all()
      .filter(row => typeof row['created'] === 'string' && row['created'] <= cutoff && !pinned.has(row['id'] as string))
      .map(row => ({ id: row['id'] as string, bytes: Number(row['bytes']) }));
  }

  private pinned(): ReadonlySet<string> {
    const rows = this.db.prepare(`SELECT t.attachment_id AS id FROM task_attachments t JOIN tasks k ON k.id=t.task_id
        WHERE json_extract(k.payload,'$.status') IN ('draft','queued','running')
      UNION SELECT p.attachment_id FROM pending_attachments p JOIN pending_messages m ON m.id=p.pending_id
        WHERE json_extract(m.payload,'$.status')='queued'
      UNION SELECT json_extract(j.value,'$.attachmentId') FROM steering_messages s JOIN tasks k ON k.id=s.task_id JOIN json_each(s.parts) j
        WHERE json_extract(k.payload,'$.status') IN ('draft','queued','running') AND json_extract(j.value,'$.type')='attachment'`).all();
    return new Set(rows.map(row => row['id'] as string));
  }

  private evict(id: string): void {
    const referenced = this.db.prepare(`SELECT 1 FROM task_attachments WHERE attachment_id=?
      UNION ALL SELECT 1 FROM pending_attachments WHERE attachment_id=? LIMIT 1`).get(id, id);
    if (referenced) {
      this.db.prepare('UPDATE attachments SET bytes=0 WHERE id=?').run(id);
      return;
    }
    this.db.prepare('DELETE FROM attachments WHERE id=?').run(id);
  }
}
