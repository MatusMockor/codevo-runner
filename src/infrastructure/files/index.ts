import { EXECUTION_LIMITS } from '../../domain/execution.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, opendir, unlink, link, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { validateTextAttachment } from '../../domain/text-attachment.js';
import sharp from 'sharp';
import { validateImageEnvelope } from './image-preflight.js';
import type { AttachmentContent, AttachmentRepository, AttachmentStore } from '../../application/ports.js';
import { isId, LIMITS, RunnerError, type Attachment, type FileAttachment, type MediaType } from '../../domain/contracts.js';
import { FILE_ATTACHMENT_KIND, isAttachmentName, isFileMediaType } from '../../domain/file-attachment.js';
import { openVerifiedBlob, verifyBlob } from './blob-stream.js';
import { assertDirectory } from './directory.js';

export type AttachmentStoreOptions = Readonly<{ fileUploadTimeoutMs?: number; fileUploadIdleTimeoutMs?: number; now?: () => Date }>;
type Format = Readonly<{ mediaType: 'image/png' | 'image/jpeg'; width: number; height: number }> | Readonly<{ mediaType: 'text/plain' }> |
  Readonly<{ kind: 'file'; mediaType: string }>;
type UploadPlan = Readonly<{
  maximumBytes: number;
  received?: () => void;
  inspect(staged: string, bytes: number, signal: AbortSignal): Promise<Format>;
  verifyStored(final: string, existing: Attachment): Promise<unknown>;
  adopt(final: string, value: Attachment, signal: AbortSignal): Promise<void>;
}>;

const unavailable = () => new RunnerError('storage_unavailable');
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw unavailable();
}
function translate(error: unknown): never {
  if (error instanceof RunnerError) throw error;
  throw unavailable();
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
function validateInput(id: string, name: string, mediaType: string): asserts mediaType is MediaType {
  if (!isId(id) || !isAttachmentName(name)) {
    throw new RunnerError('invalid_input');
  }
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'text/plain') throw new RunnerError('unsupported_media');
}
async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.attachmentBytes) throw unavailable();
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (!bytesRead) throw unavailable();
      offset += bytesRead;
    }
    return result;
  } finally { await handle.close(); }
}
async function inspectImage(path: string, mediaType: MediaType, signal: AbortSignal): Promise<{ width: number; height: number }> {
  try {
    const encoded = await readBounded(path);
    assertActive(signal);
    validateImageEnvelope(encoded, mediaType);
    const decoder = sharp(path, { failOn: 'warning', limitInputPixels: LIMITS.imagePixels }).timeout({ seconds: 10 });
    const metadata = await decoder.metadata();
    assertActive(signal);
    const expected = mediaType === 'image/png' ? 'png' : 'jpeg';
    if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new RunnerError('unsupported_media');
    if (metadata.width > LIMITS.imageDimension || metadata.height > LIMITS.imageDimension || metadata.width * metadata.height > LIMITS.imagePixels) throw new RunnerError('too_large');
    await decoder.stats();
    assertActive(signal);
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('unsupported_media');
  }
}

class FileAttachmentStore implements AttachmentStore {
  private readonly active = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  private closed = false;
  private readonly reads = new Set<Promise<unknown>>();
  private readSlots = 0;
  private readonly waitingReads: Array<{ resolve: () => void; reject: (error: RunnerError) => void }> = [];
  private readonly streams = new Set<AttachmentContent>();
  private publishing: Promise<unknown> = Promise.resolve();
  private readonly fileUploadTimeoutMs: number;
  private readonly fileUploadIdleTimeoutMs: number;
  private readonly now: () => Date;
  constructor(private readonly directory: string, private readonly runnerId: string, private readonly repository: AttachmentRepository, options: AttachmentStoreOptions = {}) {
    this.fileUploadTimeoutMs = options.fileUploadTimeoutMs ?? LIMITS.fileUploadTimeoutMs;
    this.fileUploadIdleTimeoutMs = options.fileUploadIdleTimeoutMs ?? LIMITS.fileUploadIdleTimeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  async upload(id: string, name: string, mediaType: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    validateInput(id, name, mediaType);
    const plan: UploadPlan = {
      maximumBytes: LIMITS.attachmentBytes,
      inspect: async (staged, _bytes, active) => mediaType === 'text/plain'
        ? (validateTextAttachment(await readBounded(staged)), { mediaType } as const)
        : { mediaType, ...await inspectImage(staged, mediaType, active) },
      verifyStored: () => this.read(id),
      adopt: async (final, value, active) => {
        const original = await readBounded(final);
        assertActive(active);
        if (original.length !== value.bytes || createHash('sha256').update(original).digest('hex') !== value.sha256) throw new RunnerError('conflict');
      },
    };
    return this.admit(id, [signal, AbortSignal.timeout(LIMITS.uploadTimeoutMs)], combined => this.persist(id, name, plan, source, combined));
  }

  async uploadFile(id: string, name: string, mediaType: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    if (!isId(id) || !isAttachmentName(name)) throw new RunnerError('invalid_input');
    if (!isFileMediaType(mediaType)) throw new RunnerError('unsupported_media');
    const deadline = new AbortController();
    const expire = () => deadline.abort();
    const total = setTimeout(expire, this.fileUploadTimeoutMs);
    const idle = setTimeout(expire, this.fileUploadIdleTimeoutMs);
    total.unref();
    idle.unref();
    const plan: UploadPlan = {
      maximumBytes: LIMITS.fileAttachmentBytes,
      received: () => { idle.refresh(); },
      inspect: async (_staged, bytes) => {
        clearTimeout(idle);
        if (!bytes) throw new RunnerError('invalid_input');
        return { kind: FILE_ATTACHMENT_KIND, mediaType };
      },
      verifyStored: (final, existing) => verifyBlob(final, existing, LIMITS.fileAttachmentBytes),
      adopt: async (final, value) => {
        try { await verifyBlob(final, value, LIMITS.fileAttachmentBytes); }
        catch (error) {
          if (error instanceof RunnerError) throw new RunnerError('conflict');
          throw error;
        }
      },
    };
    try {
      const result = await this.admit(id, [signal, deadline.signal], combined => this.persist(id, name, plan, source, combined));
      if (result.attachment.kind !== FILE_ATTACHMENT_KIND) throw new RunnerError('conflict');
      return { attachment: result.attachment as FileAttachment, created: result.created };
    } catch (error) {
      if (deadline.signal.aborted && !signal.aborted && !this.closed) throw new RunnerError('request_timeout');
      throw error;
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
    }
  }

  private async admit<T>(id: string, signals: readonly AbortSignal[], start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw unavailable();
    if (this.active.has(id) || this.active.size >= LIMITS.uploads) throw new RunnerError('busy');
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...signals]);
    const work = start(combined);
    this.active.set(id, { controller, work });
    try { return await work; } finally { this.active.delete(id); }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.publishing.then(action, action);
    this.publishing = run.catch(() => undefined);
    return run;
  }

  private async persist(id: string, name: string, plan: UploadPlan, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const staged = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const final = join(this.directory, `${id}.blob`);
    try {
      const { bytes, sha256 } = await this.receive(staged, source, signal, plan);
      assertActive(signal);
      const format = await plan.inspect(staged, bytes, signal);
      assertActive(signal);
      const value: Attachment = { id, runnerId: this.runnerId, name, bytes, sha256, ...format, createdAt: this.now().toISOString() };
      return await this.exclusive(() => this.publish(value, staged, final, plan, signal));
    } catch (error) {
      return translate(error);
    } finally { await unlink(staged).catch(() => undefined); }
  }

  private async publish(value: Attachment, staged: string, final: string, plan: UploadPlan, signal: AbortSignal) {
    const { id } = value;
    let published = false;
    try {
      assertActive(signal);
      let existing: Attachment | undefined;
      try { existing = await this.repository.getAttachment(id); } catch (error) {
        if (!(error instanceof RunnerError) || error.code !== 'not_found') throw error;
      }
      assertActive(signal);
      if (existing) {
        if (existing.name !== value.name || existing.kind !== value.kind || existing.mediaType !== value.mediaType || existing.sha256 !== value.sha256 || existing.bytes !== value.bytes) throw new RunnerError('conflict');
        await plan.verifyStored(final, existing);
        assertActive(signal);
        return { attachment: existing, created: false };
      }
      try {
        assertActive(signal);
        await link(staged, final);
        published = true;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        // A prior crash may have left a durable file without database metadata.
        // Adopt matching bytes without taking ownership of this preexisting file.
        await plan.adopt(final, value, signal);
        assertActive(signal);
      }
      assertActive(signal);
      await syncDirectory(this.directory);
      assertActive(signal);
      const stored = await this.repository.putAttachment(value);
      await this.discard(stored.evicted ?? []);
      return { attachment: stored.attachment, created: stored.created };
    } catch (error) {
      if (published) {
        // Never remove an artifact whose transaction may have committed.
        try { await this.repository.getAttachment(id); } catch (lookupError) {
          if (lookupError instanceof RunnerError && lookupError.code === 'not_found') await unlink(final).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async discard(evicted: readonly string[]): Promise<void> {
    const ids = evicted.filter(isId);
    if (!ids.length) return;
    for (const id of ids) await unlink(join(this.directory, `${id}.blob`)).catch(() => undefined);
    await syncDirectory(this.directory).catch(() => undefined);
  }

  private async unreadable(id: string, error: unknown): Promise<never> {
    if (error instanceof RunnerError) throw error;
    await this.repository.getAttachment(id);
    throw unavailable();
  }

  private async receive(path: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal, plan: UploadPlan) {
    const handle = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    const iterator = source[Symbol.asyncIterator]();
    let bytes = 0;
    let rejectAbort: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => undefined);
    const onAbort = () => rejectAbort(unavailable());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw unavailable();
        const chunk = await Promise.race([iterator.next(), aborted]);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw new RunnerError('invalid_input');
        if (chunk.value.byteLength) plan.received?.();
        bytes += chunk.value.byteLength;
        if (bytes > plan.maximumBytes) throw new RunnerError('too_large');
        hash.update(chunk.value);
        await handle.writeFile(chunk.value);
      }
      await handle.sync();
      return { bytes, sha256: hash.digest('hex') };
    } finally {
      signal.removeEventListener('abort', onAbort);
      // A stalled external iterator must not prevent cancellation or shutdown.
      void iterator.return?.().catch(() => undefined);
      await handle.close();
    }
  }

  private async trackedRead<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw unavailable();
    // Keep two blob allocations active; waiting executions retain no blob buffers.
    if (this.waitingReads.length >= EXECUTION_LIMITS.activeTasks * 2) throw new RunnerError('busy');
    const admission = this.readSlots < 2
      ? (this.readSlots++, Promise.resolve())
      : new Promise<void>((resolve, reject) => this.waitingReads.push({ resolve, reject }));
    const work = (async () => {
      await admission;
      try {
        if (this.closed) throw unavailable();
        const result = await operation();
        if (this.closed) throw unavailable();
        return result;
      } finally {
        this.readSlots--;
        if (!this.closed) {
          const next = this.waitingReads.shift();
          if (next) { this.readSlots++; next.resolve(); }
        }
      }
    })();
    this.reads.add(work);
    try { return await work; } finally { this.reads.delete(work); }
  }

  async metadata(id: string): Promise<Attachment> {
    if (!isId(id)) throw new RunnerError('invalid_input');
    return this.trackedRead(() => this.repository.getAttachment(id));
  }

  async read(id: string) {
    if (!isId(id)) throw new RunnerError('invalid_input');
    return this.trackedRead(async () => {
      const attachment = await this.repository.getAttachment(id);
      if (attachment.kind === FILE_ATTACHMENT_KIND) throw new RunnerError('unsupported_media');
      try {
        const bytes = await readBounded(join(this.directory, `${id}.blob`));
        if (bytes.byteLength !== attachment.bytes || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw unavailable();
        return { attachment, bytes };
      } catch (error) { return this.unreadable(id, error); }
    });
  }

  async open(id: string): Promise<AttachmentContent> {
    if (!isId(id)) throw new RunnerError('invalid_input');
    return this.trackedRead(async () => {
      const attachment = await this.repository.getAttachment(id);
      try {
        const blob = await openVerifiedBlob(join(this.directory, `${id}.blob`), attachment, LIMITS.fileAttachmentBytes);
        const content: AttachmentContent = {
          attachment,
          chunks: async function* () {
            try { yield* blob.chunks(); } catch (error) { translate(error); }
          },
          close: async () => {
            this.streams.delete(content);
            await blob.close();
          },
        };
        this.streams.add(content);
        return content;
      } catch (error) { return this.unreadable(id, error); }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.waitingReads.splice(0)) waiting.reject(unavailable());
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(({ work }) => work).concat([...this.reads]));
    await Promise.allSettled([...this.streams].map(stream => stream.close()));
  }
}

export async function createAttachmentStore(dataDir: string, runnerId: string, repository: AttachmentRepository, options: AttachmentStoreOptions = {}): Promise<AttachmentStore> {
  const directory = join(dataDir, 'attachments');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory);
    const entries = await opendir(directory);
    let count = 0;
    for await (const entry of entries) {
      if (++count > LIMITS.attachments * 4) throw unavailable();
      if (!entry.isFile()) throw unavailable();
      const stat = await lstat(join(directory, entry.name));
      const stale = Date.now() - stat.mtimeMs > LIMITS.uploadTimeoutMs * 2;
      if (/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
        if (!stale) continue;
        await unlink(join(directory, entry.name));
        continue;
      }
      const id = entry.name.slice(0, -5);
      if (!entry.name.endsWith('.blob') || !isId(id)) throw unavailable();
      try { await repository.getAttachment(id); } catch (error) {
        if (!(error instanceof RunnerError) || error.code !== 'not_found') throw error;
        if (stale) await unlink(join(directory, entry.name));
      }
    }
    await syncDirectory(directory);
    return new FileAttachmentStore(directory, runnerId, repository, options);
  } catch (error) { return translate(error); }
}
