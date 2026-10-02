import { randomUUID, createHash } from 'node:crypto';
import type { ArtifactApplication, ArtifactBlobStore, ArtifactRepository, ArtifactWorkspace } from './artifact-ports.js';
import type { TaskRepository } from './ports.js';
import { artifactMediaType, parseArtifactPath } from '../domain/artifact.js';
import { isId, RunnerError } from '../domain/contracts.js';

/** Immutable snapshots are shared by both CLI providers and survive workspace changes. */
export class ArtifactService implements ArtifactApplication {
  private active = false;
  private readonly waiting: Array<{ grant: () => void; expire: () => void }> = [];
  private acquire(deadline: number, wait: boolean): Promise<() => void> {
    if (Date.now() >= deadline || (this.active && (!wait || this.waiting.length >= 63)))
      return Promise.reject(new RunnerError('busy'));
    if (!this.active) { this.active = true; return Promise.resolve(() => this.release()); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => entry.expire(), Math.max(1, deadline - Date.now()));
      const entry = {
        grant: () => { clearTimeout(timer); resolve(() => this.release()); },
        expire: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          clearTimeout(timer);
          reject(new RunnerError('busy'));
        },
      };
      this.waiting.push(entry);
    });
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.active = false;
  }
  constructor(private readonly tasks: TaskRepository, private readonly repository: ArtifactRepository,
    private readonly workspace: ArtifactWorkspace, private readonly blobs: ArtifactBlobStore) {}
  async register(taskId: string, input: unknown) { return this.capture(taskId, input, false); }
  async captureOutput(taskId: string, paths: readonly string[]): Promise<boolean> {
    let complete = paths.length <= 32;
    const deadline = Date.now() + 30_000;
    for (const path of paths.slice(0, 32)) {
      if (Date.now() >= deadline) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.capture(taskId, { path }, true, deadline),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RunnerError('busy')), Math.max(1, deadline - Date.now())); }),
        ]);
      }
      catch { complete = false; }
      finally { clearTimeout(timer); }
    }
    return complete;
  }
  private async capture(taskId: string, input: unknown, completing: boolean, deadline = Date.now() + 30_000) {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    const reference = parseArtifactPath(input);
    const release = await this.acquire(deadline, completing);
    const checkDeadline = () => { if (Date.now() >= deadline) throw new RunnerError('busy'); };
    try {
      checkDeadline();
      const task = await this.tasks.getTask(taskId);
      checkDeadline();
      if (!(completing && task.status === 'running') && !['succeeded', 'failed', 'interrupted', 'cancelled'].includes(task.status)) throw new RunnerError('conflict');
      const path = await this.workspace.normalize(taskId, reference);
      checkDeadline();
      const previous = await this.repository.findArtifact(taskId, path);
      checkDeadline();
      if (previous) return { artifact: previous, created: false };
      const captured = await this.workspace.capture(taskId, path);
      checkDeadline();
      const artifact = { id: randomUUID(), taskId, name: path.split('/').at(-1)!, mediaType: artifactMediaType(path),
        sizeBytes: captured.bytes.byteLength, sha256: createHash('sha256').update(captured.bytes).digest('hex') };
      await this.blobs.put(artifact.id, captured.bytes);
      try {
        checkDeadline();
        const result = await this.repository.putArtifact(artifact, path);
        if (!result.created) await this.blobs.remove(artifact.id);
        return result;
      } catch (error) { await this.blobs.remove(artifact.id); throw error; }
    } finally { release(); }
  }
  async list(taskId: string) {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    await this.tasks.getTask(taskId);
    return { items: await this.repository.listArtifacts(taskId) };
  }
  async read(taskId: string, id: string) {
    if (!isId(taskId) || !isId(id)) throw new RunnerError('invalid_input');
    const artifact = await this.repository.getArtifact(taskId, id);
    return { artifact, bytes: await this.blobs.read(artifact) };
  }
}
