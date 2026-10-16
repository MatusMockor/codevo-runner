import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpDeviceSyncLedgerRepository } from '../../application/mcp-device-sync.js';
import { RunnerError } from '../../domain/contracts.js';
import { validProjectId } from '../../domain/git-sync.js';
import {
  EMPTY_MCP_DEVICE_SYNC_LEDGER, MCP_DEVICE_SYNC_LIMITS, parseMcpDeviceSyncLedger, serializeMcpDeviceSyncLedger, type McpDeviceSyncLedger,
} from '../../domain/mcp-device-sync.js';

const CORRUPT: McpDeviceSyncLedger = Object.freeze({ kind: 'corrupt' });
const LEDGER_DIRECTORY = 'mcp-device-sync';

async function contents(path: string): Promise<McpDeviceSyncLedger> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? EMPTY_MCP_DEVICE_SYNC_LEDGER : CORRUPT; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MCP_DEVICE_SYNC_LIMITS.ledgerBytes) return CORRUPT;
    const bytes = Buffer.alloc(MCP_DEVICE_SYNC_LIMITS.ledgerBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MCP_DEVICE_SYNC_LIMITS.ledgerBytes) return CORRUPT;
    }
    return parseMcpDeviceSyncLedger(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))));
  } catch { return CORRUPT; }
  finally { await handle.close(); }
}

export class FileMcpDeviceSyncLedger implements McpDeviceSyncLedgerRepository {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, LEDGER_DIRECTORY);
  }

  async load(projectId: string, signal: AbortSignal): Promise<McpDeviceSyncLedger> {
    signal.throwIfAborted();
    return contents(this.path(projectId));
  }

  async save(projectId: string, servers: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const target = this.path(projectId);
    const bytes = Buffer.from(serializeMcpDeviceSyncLedger(servers));
    if (bytes.length > MCP_DEVICE_SYNC_LIMITS.ledgerBytes) throw new RunnerError('storage_unavailable');
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('storage_unavailable');
      const temporary = join(this.root, `.${projectId}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        signal.throwIfAborted();
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => undefined); }
      const directory = await open(this.root, 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch { throw new RunnerError('storage_unavailable'); }
  }

  private path(projectId: string): string {
    if (!validProjectId(projectId)) throw new RunnerError('not_found');
    return join(this.root, `${projectId}.json`);
  }
}
