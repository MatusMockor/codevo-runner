import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactBlobStore } from '../../application/artifact-ports.js';
import { ARTIFACT_LIMITS, type Artifact } from '../../domain/artifact.js';
import { isId, RunnerError } from '../../domain/contracts.js';

/** Private immutable copies, bounded independently from source workspaces. */
export class FileArtifactBlobs implements ArtifactBlobStore {
  private constructor(private readonly root: string, private readonly identity: { dev: number; ino: number }, private retained: number) {}
  static async open(dataDir: string, committedIds: readonly string[]) {
    const root = resolve(dataDir, 'artifacts');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('conflict');
    const committed = new Set(committedIds);
    let retained = 0;
    let count = 0;
    for await (const entry of await opendir(root)) {
      if (++count > ARTIFACT_LIMITS.retained + 2 || !isId(entry.name)) throw new RunnerError('storage_unavailable');
      const file = await lstat(join(root, entry.name));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new RunnerError('conflict');
      if (!committed.has(entry.name)) { await unlink(join(root, entry.name)); continue; }
      retained += file.size;
    }
    if (retained > ARTIFACT_LIMITS.storageBytes) throw new RunnerError('quota_exceeded');
    return new FileArtifactBlobs(root, info, retained);
  }
  private async path(id: string) {
    if (!isId(id)) throw new RunnerError('invalid_input');
    const current = await lstat(this.root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new RunnerError('conflict');
    return join(this.root, id);
  }
  async put(id: string, bytes: Uint8Array) {
    if (bytes.byteLength > ARTIFACT_LIMITS.imageBytes || this.retained + bytes.byteLength > ARTIFACT_LIMITS.storageBytes) throw new RunnerError('quota_exceeded');
    this.retained += bytes.byteLength;
    let created = false;
    try {
      const path = await this.path(id);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await this.path(id);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      this.retained -= bytes.byteLength;
      if (created) await unlink(join(this.root, id)).catch(() => {});
      throw error;
    }
  }
  async read(artifact: Artifact) {
    const file = await open(await this.path(artifact.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== artifact.sizeBytes || info.size > ARTIFACT_LIMITS.imageBytes) throw new RunnerError('conflict');
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new RunnerError('conflict');
        offset += result.bytesRead;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new RunnerError('conflict');
      await this.path(artifact.id);
      return bytes;
    } finally { await file.close(); }
  }
  async remove(id: string) {
    const path = await this.path(id);
    const info = await lstat(path);
    await unlink(path);
    this.retained -= info.size;
  }
}
