import { validateTextAttachment } from '../../domain/text-attachment.js';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentStore } from '../../application/ports.js';
import type { ExecutionAttachmentStager, StagedExecutionInputs } from '../../application/execution-ports.js';
import type { StagedExecutionAttachment } from '../../domain/execution.js';
import { isId, LIMITS, RunnerError, type FileAttachment } from '../../domain/contracts.js';
import { FILE_ATTACHMENT_KIND, stagedFileName } from '../../domain/file-attachment.js';
import { assertDirectory } from './directory.js';

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
        const metadata = await this.store.metadata(id);
        if (metadata.kind === FILE_ATTACHMENT_KIND) {
          attachments.push(await this.stageFile(directory, metadata));
          continue;
        }
        const { attachment, bytes } = await this.store.read(id);
        if (bytes.byteLength > LIMITS.attachmentBytes) throw new RunnerError('too_large');
        if (attachment.mediaType !== 'image/png' && attachment.mediaType !== 'image/jpeg' && attachment.mediaType !== 'text/plain') throw new RunnerError('unsupported_media');
        if (attachment.mediaType === 'text/plain') validateTextAttachment(bytes);
        const extension = attachment.mediaType === 'text/plain' ? 'txt' : attachment.mediaType === 'image/png' ? 'png' : 'jpg';
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

  private async stageFile(directory: string, expected: FileAttachment): Promise<StagedExecutionAttachment> {
    if (expected.bytes < 1 || expected.bytes > LIMITS.fileAttachmentBytes) throw new RunnerError('too_large');
    const content = await this.store.open(expected.id);
    try {
      const { attachment } = content;
      if (attachment.kind !== FILE_ATTACHMENT_KIND || attachment.id !== expected.id || attachment.sha256 !== expected.sha256 || attachment.bytes !== expected.bytes) throw new RunnerError('storage_unavailable');
      const owner = join(directory, attachment.id);
      await mkdir(owner, { mode: 0o700 });
      const path = join(owner, stagedFileName(attachment.name));
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let written = 0;
        for await (const chunk of content.chunks()) {
          written += chunk.byteLength;
          if (written > attachment.bytes) throw new RunnerError('storage_unavailable');
          await file.writeFile(chunk);
        }
        if (written !== attachment.bytes || (await file.stat()).size !== attachment.bytes) throw new RunnerError('storage_unavailable');
      } finally { await file.close(); }
      return { kind: FILE_ATTACHMENT_KIND, id: attachment.id, path, mediaType: attachment.mediaType, name: attachment.name, bytes: attachment.bytes };
    } finally { await content.close(); }
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
