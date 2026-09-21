import { writeSync } from 'node:fs';
import { RunnerError } from '../../domain/contracts.js';

/** Own pending input until the PTY closes; no asynchronous write may outlive its fd. */
export class PtyInput {
  private readonly queue: { bytes: Buffer; offset: number }[] = [];
  private head = 0;
  private pending = 0;
  private retry: NodeJS.Timeout | undefined;
  private closed = false;
  constructor(private readonly fd: number, private readonly writeBytes: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync, private readonly isOwned: () => boolean = () => true) {
    if (!Number.isSafeInteger(fd) || fd < 0) throw new RunnerError('storage_unavailable');
  }
  write(value: string): void {
    if (!this.isOwned()) this.close();
    if (this.closed) throw new RunnerError('conflict');
    const size = Buffer.byteLength(value);
    if (this.pending + size > 262_144 || this.queue.length - this.head >= 4096) throw new RunnerError('busy');
    if (!size) return;
    const bytes = Buffer.from(value);
    this.queue.push({ bytes, offset: 0 }); this.pending += bytes.length;
    if (!this.retry) this.retry = setTimeout(() => this.drain(), 0).unref();
  }
  close(): void {
    this.closed = true; clearTimeout(this.retry); this.retry = undefined;
    this.queue.length = 0; this.head = 0; this.pending = 0;
  }
  private drain(): void {
    this.retry = undefined;
    if (this.closed) return;
    // node-pty masters are nonblocking. Synchronous writes cannot race descriptor
    // reuse after close, and each drain has a fixed work budget.
    let budget = 65_536; let operations = 64;
    try {
      while (this.head < this.queue.length && budget > 0 && operations-- > 0) {
        if (!this.isOwned()) { this.close(); return; }
        const head = this.queue[this.head]!;
        const written = this.writeBytes(this.fd, head.bytes, head.offset, Math.min(head.bytes.length - head.offset, budget));
        if (!written) break;
        head.offset += written; this.pending -= written; budget -= written;
        if (head.offset === head.bytes.length) this.head++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' && (error as NodeJS.ErrnoException).code !== 'EWOULDBLOCK') {
        this.close(); return;
      }
    }
    if (this.head) { this.queue.splice(0, this.head); this.head = 0; }
    if (this.queue.length) this.retry = setTimeout(() => this.drain(), 10).unref();
  }
}
