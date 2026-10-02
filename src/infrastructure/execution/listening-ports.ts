import { open, readdir, readlink } from 'node:fs/promises';
import { endianness } from 'node:os';
import { basename } from 'node:path';
import type { ListeningPortScanner, PortOwner, PortScan } from '../../application/port-preview-ports.js';
import { processName, type ListeningPort, type PortSource } from '../../domain/port-preview.js';
import type { OwnedProcess } from '../../domain/process-ownership.js';
import { parseTcpTable, socketInode, type ByteOrder, type SocketFamily, type TcpListener } from './proc-net.js';

export type ListeningPortLimits = Readonly<{ fdsPerProcess: number; fdsTotal: number; tableBytes: number; tableLines: number }>;
export const LISTENING_PORT_LIMITS: ListeningPortLimits = Object.freeze({
  fdsPerProcess: 1024, fdsTotal: 16_384, tableBytes: 4 * 1024 * 1024, tableLines: 65_536,
});
export type ProcScannerOptions = Readonly<{ procRoot?: string; byteOrder?: ByteOrder; limits?: Partial<ListeningPortLimits> }>;

type SocketOwner = Readonly<{ source: PortSource; pid: number; process: string }>;
type ScanState = { truncated: boolean; fds: number };
type ProcessSockets = Readonly<{ inodes: readonly string[]; process: string }>;

const TABLES: readonly (readonly [string, SocketFamily])[] = [['tcp', 'v4'], ['tcp6', 'v6']];
const SMALL_FILE_BYTES = 4096;
const CHUNK_BYTES = 65_536;
const GONE = new Set(['ENOENT', 'ESRCH']);
const HIDDEN = new Set(['EACCES', 'EPERM']);

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

function startTime(stat: string): string | undefined {
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}

async function readBounded(path: string, maxBytes: number, signal: AbortSignal): Promise<Readonly<{ text: string; truncated: boolean }>> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      if (signal.aborted) return { text: completeLines(Buffer.concat(chunks).toString('latin1')), truncated: true };
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return { text: Buffer.concat(chunks).toString('latin1'), truncated: false };
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { text: completeLines(Buffer.concat(chunks).subarray(0, maxBytes).toString('latin1')), truncated: true };
  } finally {
    await handle.close();
  }
}

function displayName(executable: string | undefined, comm: string | undefined): string {
  const program = processName(basename(executable ?? '').replace(/ \(deleted\)$/, ''));
  if (program !== 'unknown') return program;
  return processName((comm ?? '').replace(/\n$/, ''));
}

function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

export class ProcListeningPortScanner implements ListeningPortScanner {
  private readonly root: string;
  private readonly order: ByteOrder;
  private readonly limits: ListeningPortLimits;

  constructor(options: ProcScannerOptions = {}) {
    this.root = options.procRoot ?? '/proc';
    this.order = options.byteOrder ?? endianness();
    this.limits = { ...LISTENING_PORT_LIMITS, ...options.limits };
  }

  async scan(owners: readonly PortOwner[], signal: AbortSignal): Promise<PortScan> {
    const state: ScanState = { truncated: owners.some(owner => !owner.complete), fds: 0 };
    const sockets = await this.ownedSockets(owners, state, signal);
    if (sockets.size === 0) return { ports: [], truncated: state.truncated };
    const ports: ListeningPort[] = [];
    for (const listener of await this.listeners(state, signal)) {
      const holders = sockets.get(listener.inode);
      if (!holders) continue;
      for (const holder of holders) ports.push({ port: listener.port, address: listener.address, source: holder.source, process: holder.process });
    }
    return { ports, truncated: state.truncated };
  }

  private async ownedSockets(owners: readonly PortOwner[], state: ScanState, signal: AbortSignal): Promise<Map<string, SocketOwner[]>> {
    const sockets = new Map<string, SocketOwner[]>();
    const visited = new Set<string>();
    for (const owner of owners) {
      for (const owned of [...owner.processes].sort((left, right) => left.pid - right.pid)) {
        const key = `${owner.source}:${owned.pid}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (signal.aborted || state.fds >= this.limits.fdsTotal) {
          state.truncated = true;
          return sockets;
        }
        const found = await this.processSockets(owned, state, signal);
        if (!found) continue;
        for (const inode of found.inodes) this.addHolder(sockets, inode, { source: owner.source, pid: owned.pid, process: found.process });
      }
    }
    return sockets;
  }

  private addHolder(sockets: Map<string, SocketOwner[]>, inode: string, holder: SocketOwner): void {
    const holders = sockets.get(inode) ?? [];
    if (holders.some(existing => existing.source === holder.source)) return;
    holders.push(holder);
    sockets.set(inode, holders);
  }

  private async processSockets(owned: OwnedProcess, state: ScanState, signal: AbortSignal): Promise<ProcessSockets | undefined> {
    const base = `${this.root}/${owned.pid}`;
    let names: string[];
    try {
      names = (await readdir(`${base}/fd`)).filter(name => /^\d{1,10}$/.test(name)).sort((left, right) => Number(left) - Number(right));
    } catch (error) {
      if (HIDDEN.has(errorCode(error))) state.truncated = true;
      if (GONE.has(errorCode(error)) || HIDDEN.has(errorCode(error))) return undefined;
      throw error;
    }
    const budget = Math.min(this.limits.fdsPerProcess, this.limits.fdsTotal - state.fds);
    if (names.length > budget) {
      state.truncated = true;
      names = names.slice(0, budget);
    }
    state.fds += names.length;
    const links = await Promise.all(names.map(name => readlink(`${base}/fd/${name}`).catch((error: unknown) => {
      if (HIDDEN.has(errorCode(error))) state.truncated = true;
      return undefined;
    })));
    const inodes = links.flatMap(link => {
      const inode = link === undefined ? undefined : socketInode(link);
      return inode ? [inode] : [];
    });
    if (inodes.length === 0) return undefined;
    const executable = await readlink(`${base}/exe`).catch(() => undefined);
    const comm = await this.readSmall(`${base}/comm`, signal);
    const stat = await this.readSmall(`${base}/stat`, signal);
    if (signal.aborted) state.truncated = true;
    if (stat === undefined || startTime(stat) !== owned.start) return undefined;
    return { inodes, process: displayName(executable, comm) };
  }

  private async readSmall(path: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const { text, truncated } = await readBounded(path, SMALL_FILE_BYTES, signal);
      return truncated ? undefined : text;
    } catch (error) {
      if (GONE.has(errorCode(error)) || HIDDEN.has(errorCode(error))) return undefined;
      throw error;
    }
  }

  private async listeners(state: ScanState, signal: AbortSignal): Promise<readonly TcpListener[]> {
    const listeners: TcpListener[] = [];
    for (const [file, family] of TABLES) {
      let read;
      try { read = await readBounded(`${this.root}/net/${file}`, this.limits.tableBytes, signal); }
      catch (error) {
        if (GONE.has(errorCode(error))) continue;
        throw error;
      }
      const table = parseTcpTable(read.text, family, this.order, this.limits.tableLines);
      if (read.truncated || table.truncated) state.truncated = true;
      listeners.push(...table.listeners);
    }
    return listeners;
  }
}
