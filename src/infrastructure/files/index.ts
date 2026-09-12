import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, opendir, unlink, link, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import sharp from 'sharp';
import { validateImageEnvelope } from './image-preflight.js';
import type { AttachmentRepository, AttachmentStore } from '../../application/ports.js';
import { isId, LIMITS, RunnerError, type Attachment, type MediaType } from '../../domain/contracts.js';

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
  if (!isId(id) || !name.trim() || /[\/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255 || /[\uD800-\uDFFF]/u.test(name)) {
    throw new RunnerError('invalid_input');
  }
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') throw new RunnerError('unsupported_media');
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
  constructor(private readonly directory: string, private readonly runnerId: string, private readonly repository: AttachmentRepository) {}

  async upload(id: string, name: string, mediaType: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    validateInput(id, name, mediaType);
    if (this.closed) throw unavailable();
    if (this.active.has(id) || this.active.size >= LIMITS.uploads) throw new RunnerError('busy');
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(LIMITS.uploadTimeoutMs)]);
    const work = this.persist(id, name, mediaType, source, combined);
    this.active.set(id, { controller, work });
    try { return await work; } finally { this.active.delete(id); }
  }

  private async persist(id: string, name: string, mediaType: MediaType, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const staged = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const final = join(this.directory, `${id}.blob`);
    let published = false;
    try {
      const { bytes, sha256 } = await this.receive(staged, source, signal);
      assertActive(signal);
      const dimensions = await inspectImage(staged, mediaType, signal);
      assertActive(signal);
      const value: Attachment = { id, runnerId: this.runnerId, name, mediaType, bytes, sha256, ...dimensions, createdAt: new Date().toISOString() };
      let existing: Attachment | undefined;
      try { existing = await this.repository.getAttachment(id); } catch (error) {
        if (!(error instanceof RunnerError) || error.code !== 'not_found') throw error;
      }
      assertActive(signal);
      if (existing) {
        if (existing.name !== name || existing.mediaType !== mediaType || existing.sha256 !== sha256 || existing.bytes !== bytes) throw new RunnerError('conflict');
        await this.read(id);
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
        const original = await readBounded(final);
        assertActive(signal);
        if (original.length !== bytes || createHash('sha256').update(original).digest('hex') !== sha256) throw new RunnerError('conflict');
      }
      assertActive(signal);
      await syncDirectory(this.directory);
      assertActive(signal);
      return await this.repository.putAttachment(value);
    } catch (error) {
      if (published) {
        // Never remove an artifact whose transaction may have committed.
        try { await this.repository.getAttachment(id); } catch (lookupError) {
          if (lookupError instanceof RunnerError && lookupError.code === 'not_found') await unlink(final).catch(() => undefined);
        }
      }
      return translate(error);
    } finally { await unlink(staged).catch(() => undefined); }
  }

  private async receive(path: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal) {
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
        bytes += chunk.value.byteLength;
        if (bytes > LIMITS.attachmentBytes) throw new RunnerError('too_large');
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
    if (this.reads.size >= LIMITS.uploads) throw new RunnerError('busy');
    const work = operation();
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
      try {
        const bytes = await readBounded(join(this.directory, `${id}.blob`));
        if (bytes.byteLength !== attachment.bytes || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw unavailable();
        return { attachment, bytes };
      } catch (error) { return translate(error); }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(({ work }) => work).concat([...this.reads]));
  }
}

export async function createAttachmentStore(dataDir: string, runnerId: string, repository: AttachmentRepository): Promise<AttachmentStore> {
  const directory = join(dataDir, 'attachments');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await opendir(directory);
    let count = 0;
    for await (const entry of entries) {
      if (++count > 1024) throw unavailable();
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
    return new FileAttachmentStore(directory, runnerId, repository);
  } catch (error) { return translate(error); }
}
