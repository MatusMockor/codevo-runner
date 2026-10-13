import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { RunnerError } from '../../domain/contracts.js';

const CHUNK_BYTES = 64 * 1024;
export type BlobExpectation = Readonly<{ bytes: number; sha256: string }>;
export interface VerifiedBlob {
  chunks(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

const unavailable = () => new RunnerError('storage_unavailable');

async function* verifiedChunks(handle: FileHandle, expected: BlobExpectation): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let offset = 0;
  let held: Uint8Array | undefined;
  while (offset < expected.bytes) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, expected.bytes - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw unavailable();
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    offset += bytesRead;
    if (held) yield held;
    held = chunk;
  }
  const trailing = await handle.read(Buffer.alloc(1), 0, 1, offset);
  if (trailing.bytesRead || hash.digest('hex') !== expected.sha256) throw unavailable();
  if (held) yield held;
}

export async function openVerifiedBlob(path: string, expected: BlobExpectation, maximumBytes: number): Promise<VerifiedBlob> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= handle.close();
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.bytes || stat.size > maximumBytes) throw unavailable();
  } catch (error) {
    await close();
    throw error;
  }
  return { chunks: () => verifiedChunks(handle, expected), close };
}

export async function verifyBlob(path: string, expected: BlobExpectation, maximumBytes: number): Promise<void> {
  const blob = await openVerifiedBlob(path, expected, maximumBytes);
  try { for await (const _chunk of blob.chunks()) continue; }
  finally { await blob.close(); }
}
