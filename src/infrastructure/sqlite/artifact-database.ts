import type { DatabaseSync } from 'node:sqlite';
import { ARTIFACT_LIMITS, type Artifact } from '../../domain/artifact.js';
import { RunnerError, type Task } from '../../domain/contracts.js';

export const ARTIFACT_SCHEMA = `CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_path TEXT NOT NULL,
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  PRIMARY KEY(task_id, source_path)
);`;

/** Metadata remains task-owned; captured bytes are held by the artifact store. */
export class ArtifactDatabase {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly getTask: (id: string) => Task,
    private readonly requireCapacity: () => void,
  ) {}

  findArtifact(taskId: string, path: string): Artifact | null {
    this.getTask(taskId);
    const row = this.db.prepare('SELECT payload FROM artifacts WHERE task_id=? AND source_path=?').get(taskId, path);
    return row ? JSON.parse(row['payload'] as string) as Artifact : null;
  }

  getArtifact(taskId: string, id: string): Artifact {
    this.getTask(taskId);
    const row = this.db.prepare('SELECT payload FROM artifacts WHERE task_id=? AND id=?').get(taskId, id);
    if (!row) throw new RunnerError('not_found');
    return JSON.parse(row['payload'] as string) as Artifact;
  }

  listArtifacts(taskId: string): readonly Artifact[] {
    this.getTask(taskId);
    return this.db.prepare('SELECT payload FROM artifacts WHERE task_id=? ORDER BY rowid LIMIT ?')
      .all(taskId, ARTIFACT_LIMITS.perTask).map(row => JSON.parse(row['payload'] as string) as Artifact);
  }

  listArtifactIds(): readonly string[] {
    const rows = this.db.prepare('SELECT id FROM artifacts ORDER BY rowid LIMIT 32001').all();
    if (rows.length > 32000) throw new RunnerError('quota_exceeded');
    return rows.map(row => String(row['id']));
  }

  putArtifact(artifact: Artifact, path: string): { artifact: Artifact; created: boolean } {
    validateArtifact(artifact, path);
    return this.transaction(() => {
      const previous = this.findArtifact(artifact.taskId, path);
      if (previous) return { artifact: previous, created: false };
      const task = this.getTask(artifact.taskId);
      const conversation = this.db.prepare('SELECT latest_id FROM conversations WHERE root_id=?').get(task.conversationId ?? task.id);
      if (conversation && conversation['latest_id'] !== task.id) throw new RunnerError('conflict');
      if (this.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(artifact.id)) throw new RunnerError('conflict');
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM artifacts WHERE task_id=?').get(artifact.taskId)!['n']);
      const bytes = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM artifacts').get()!['bytes']);
      if (count >= ARTIFACT_LIMITS.perTask || bytes + artifact.sizeBytes > ARTIFACT_LIMITS.storageBytes) throw new RunnerError('quota_exceeded');
      this.requireCapacity();
      this.db.prepare('INSERT INTO artifacts(id,task_id,source_path,payload,bytes) VALUES(?,?,?,?,?)')
        .run(artifact.id, artifact.taskId, path, JSON.stringify(artifact), artifact.sizeBytes);
      this.requireCapacity();
      return { artifact, created: true };
    });
  }
}

function validateArtifact(artifact: Artifact, path: string): void {
  const limit = artifact.mediaType === 'text/html' ? ARTIFACT_LIMITS.htmlBytes : ARTIFACT_LIMITS.imageBytes;
  if (!['image/png', 'image/jpeg', 'image/webp', 'text/html'].includes(artifact.mediaType)
    || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || artifact.sizeBytes > limit
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !artifact.id || artifact.id.length > 128 || !artifact.taskId || artifact.taskId.length > 128
    || !artifact.name || Buffer.byteLength(artifact.name) > 255 || artifact.name.includes('\0')
    || !path || Buffer.byteLength(path) > 4096 || path.includes('\0')) throw new RunnerError('invalid_input');
}
