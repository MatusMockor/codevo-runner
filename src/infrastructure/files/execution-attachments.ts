import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentStore } from '../../application/ports.js';
import type { ExecutionAttachmentStager, StagedExecutionInputs } from '../../application/execution-ports.js';
import type { StagedExecutionAttachment } from '../../domain/execution.js';
import { isId, LIMITS, RunnerError } from '../../domain/contracts.js';

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunnerError('storage_unavailable');
}

class FileExecutionAttachmentStager implements ExecutionAttachmentStager {
  constructor(private readonly directory: string, private readonly store: AttachmentStore) {}

  async stage(taskId: string, attachmentIds: readonly string[]): Promise<StagedExecutionInputs> {
    if (!isId(taskId) || attachmentIds.some(id => !isId(id))) throw new RunnerError('invalid_input');
    if (attachmentIds.length > LIMITS.attachmentsPerTask) throw new RunnerError('too_large');
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new RunnerError('invalid_input');
    if (!attachmentIds.length) return { attachments: [], cleanup: async () => undefined };
    const directory = join(this.directory, taskId);
    let owned = false;
    const cleanup = async () => {
      if (!owned) return;
      await assertDirectory(this.directory);
      await rm(directory, { recursive: true, force: true });
      owned = false;
    };
    try {
      await assertDirectory(this.directory);
      // Exclusive creation never overwrites another execution's staged input.
      await mkdir(directory, { mode: 0o700 });
      owned = true;
      const attachments: StagedExecutionAttachment[] = [];
      for (const id of attachmentIds) {
        const { attachment, bytes } = await this.store.read(id);
        if (bytes.byteLength > LIMITS.attachmentBytes) throw new RunnerError('too_large');
        if (attachment.mediaType !== 'image/png' && attachment.mediaType !== 'image/jpeg') throw new RunnerError('unsupported_media');
        const extension = attachment.mediaType === 'image/png' ? 'png' : 'jpg';
        const path = join(directory, `${id}.${extension}`);
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
        attachments.push({ id, path, mediaType: attachment.mediaType });
      }
      return { attachments, cleanup };
    } catch (error) {
      await cleanup();
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('storage_unavailable');
    }
  }
}

/** Keeps prompt images outside project worktrees and independent of original blobs. */
export async function createExecutionAttachmentStager(dataDir: string, store: AttachmentStore): Promise<ExecutionAttachmentStager> {
  try {
    const directory = join(await realpath(dataDir), 'execution-inputs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory);
    return new FileExecutionAttachmentStager(directory, store);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('storage_unavailable');
  }
}
