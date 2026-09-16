import { randomUUID, createHash } from 'node:crypto';
import type { ArtifactApplication, ArtifactBlobStore, ArtifactRepository, ArtifactWorkspace } from './artifact-ports.js';
import type { TaskRepository } from './ports.js';
import { artifactMediaType, parseArtifactPath } from '../domain/artifact.js';
import { isId, RunnerError } from '../domain/contracts.js';

/** Immutable snapshots are shared by both CLI providers and survive workspace changes. */
export class ArtifactService implements ArtifactApplication {
  private active = false;
  private settled: Promise<void> = Promise.resolve();
  private settle: (() => void) | undefined;
  constructor(private readonly tasks: TaskRepository, private readonly repository: ArtifactRepository,
    private readonly workspace: ArtifactWorkspace, private readonly blobs: ArtifactBlobStore) {}
  async register(taskId: string, input: unknown) { return this.capture(taskId, input, false); }
  async captureOutput(taskId: string, paths: readonly string[]): Promise<boolean> {
    let complete = true;
    const deadline = Date.now() + 30_000;
    for (const path of paths.slice(0, 32)) {
      await this.settled;
      if (Date.now() >= deadline) return false;
      try { await this.capture(taskId, { path }, true); }
      catch { complete = false; }
    }
    return complete;
  }
  private async capture(taskId: string, input: unknown, completing: boolean) {
    if (!isId(taskId)) throw new RunnerError('invalid_input');
    const reference = parseArtifactPath(input);
    if (this.active) throw new RunnerError('busy');
    this.active = true;
    this.settled = new Promise(resolve => { this.settle = resolve; });
    try {
      const task = await this.tasks.getTask(taskId);
      if (!(completing && task.status === 'running') && !['succeeded', 'failed', 'interrupted', 'cancelled'].includes(task.status)) throw new RunnerError('conflict');
      const path = await this.workspace.normalize(taskId, reference);
      const previous = await this.repository.findArtifact(taskId, path);
      if (previous) return { artifact: previous, created: false };
      const captured = await this.workspace.capture(taskId, path);
      const artifact = { id: randomUUID(), taskId, name: path.split('/').at(-1)!, mediaType: artifactMediaType(path),
        sizeBytes: captured.bytes.byteLength, sha256: createHash('sha256').update(captured.bytes).digest('hex') };
      await this.blobs.put(artifact.id, captured.bytes);
      try {
        const result = await this.repository.putArtifact(artifact, path);
        if (!result.created) await this.blobs.remove(artifact.id);
        return result;
      } catch (error) { await this.blobs.remove(artifact.id); throw error; }
    } finally { this.active = false; this.settle?.(); this.settle = undefined; }
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
