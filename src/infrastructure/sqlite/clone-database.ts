import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RunnerError } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';
import type { CloneInput, CloneJob, StoredClone } from '../../domain/project-clone.js';

export const CLONE_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_clones (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, input TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS active_clone_name ON project_clones(name)
  WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS managed_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
);`;

type TerminalStatus = 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export class CloneDatabase {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T, private readonly requireCapacity: () => void) {}
  getClone(id: string): CloneJob {
    const row = this.db.prepare('SELECT payload FROM project_clones WHERE id=?').get(id);
    if (!row) throw new RunnerError('not_found');
    return JSON.parse(row['payload'] as string) as CloneJob;
  }
  createClone(input: CloneInput, maximumProjects = 32): CloneJob {
    const fingerprint = JSON.stringify({ url: input.url, name: input.name, branch: input.branch ?? null, ...(input.parentPath === undefined ? {} : { parentPath: input.parentPath }) });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint,payload FROM project_clones WHERE key=?').get(input.idempotencyKey);
      if (previous) {
        if (previous['fingerprint'] !== fingerprint) throw new RunnerError('conflict');
        return JSON.parse(previous['payload'] as string) as CloneJob;
      }
      if (this.db.prepare("SELECT 1 FROM project_clones WHERE name=? AND status IN ('queued','running')").get(input.name)
        || this.db.prepare('SELECT 1 FROM managed_projects WHERE name=?').get(input.name)) throw new RunnerError('conflict');
      const total = Number(this.db.prepare('SELECT count(*) AS n FROM project_clones').get()!['n']);
      const active = Number(this.db.prepare("SELECT count(*) AS n FROM project_clones WHERE status IN ('queued','running')").get()!['n']);
      const projects = Number(this.db.prepare('SELECT count(*) AS n FROM managed_projects').get()!['n']);
      if (total >= 1000 || projects + active >= Math.max(0, Math.min(32, maximumProjects))) throw new RunnerError('quota_exceeded');
      if (active >= 8) throw new RunnerError('busy');
      this.requireCapacity();
      const job: CloneJob = { id: randomUUID(), status: 'queued', project: null, error: null };
      this.db.prepare('INSERT INTO project_clones(id,key,fingerprint,name,status,input,payload) VALUES(?,?,?,?,?,?,?)')
        .run(job.id, input.idempotencyKey, fingerprint, input.name, job.status, JSON.stringify(input), JSON.stringify(job));
      this.requireCapacity();
      return job;
    });
  }
  private save(job: CloneJob): CloneJob {
    this.db.prepare('UPDATE project_clones SET status=?,payload=? WHERE id=?').run(job.status, JSON.stringify(job), job.id);
    return job;
  }
  claimClone(): StoredClone | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT payload,input FROM project_clones WHERE status='queued' ORDER BY sequence LIMIT 1").get();
      if (!row) return null;
      const job = this.save({ ...JSON.parse(row['payload'] as string) as CloneJob, status: 'running' });
      return { job, input: JSON.parse(row['input'] as string) as CloneInput };
    });
  }
  finishClone(id: string, status: TerminalStatus, project: RegisteredProject | null, error: string | null): CloneJob {
    return this.transaction(() => {
      const job = this.getClone(id);
      if (job.status !== 'running') return job;
      if (status === 'succeeded') {
        const row = this.db.prepare('SELECT name FROM project_clones WHERE id=?').get(id)!;
        if (!project || project.id !== row['name'] || project.name !== row['name']) throw new RunnerError('invalid_input');
        if (this.db.prepare('SELECT 1 FROM managed_projects WHERE id=? OR name=?').get(project.id, project.name)) throw new RunnerError('conflict');
        this.db.prepare('INSERT INTO managed_projects(id,name,payload) VALUES(?,?,?)').run(project.id, project.name, JSON.stringify(project));
        return this.save({ ...job, status, project: { id: project.id, name: project.name }, error: null });
      }
      return this.save({ ...job, status, project: null, error: error?.slice(0, 256) ?? null });
    });
  }
  cancelClone(id: string): CloneJob {
    return this.transaction(() => {
      const job = this.getClone(id);
      if (job.status !== 'queued' && job.status !== 'running') return job;
      return this.save({ ...job, status: 'cancelled', error: null });
    });
  }
  interruptClones(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT payload FROM project_clones WHERE status IN ('queued','running')").all();
      for (const row of rows) this.save({ ...JSON.parse(row['payload'] as string) as CloneJob, status: 'interrupted', error: 'Runner restarted. An incomplete destination may remain; inspect it on the server before retrying.' });
    });
  }
  listManagedProjects(): readonly RegisteredProject[] {
    return this.db.prepare('SELECT payload FROM managed_projects ORDER BY name').all().map(row => JSON.parse(row['payload'] as string) as RegisteredProject);
  }
}
