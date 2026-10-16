import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ClaudeLocalConfigReader } from '../../application/mcp-device-sync.js';
import type { McpServersWorkdir } from '../../application/mcp-servers-service.js';
import { RunnerError } from '../../domain/contracts.js';
import { claudeLocalServers, type ClaudeStoredServers } from '../../domain/mcp-device-sync.js';
import { providerEnvironment } from './cli-executor.js';

export const CLAUDE_LOCAL_CONFIG_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CONFIG_FILE = '.claude.json';

function unavailable(): RunnerError { return new RunnerError('storage_unavailable'); }

export function claudeConfigPath(env: NodeJS.ProcessEnv = providerEnvironment()): string | null {
  const directory = env.CLAUDE_CONFIG_DIR;
  if (directory) return isAbsolute(directory) ? join(directory, CONFIG_FILE) : null;
  const home = env.HOME || homedir();
  return isAbsolute(home) ? join(home, CONFIG_FILE) : null;
}

async function opened(path: string): Promise<FileHandle | null> {
  try { return await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unavailable();
  }
}

async function bounded(handle: FileHandle, maximum: number, signal: AbortSignal): Promise<Buffer | null> {
  const info = await handle.stat();
  if (!info.isFile() || info.size > maximum) throw unavailable();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maximum + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) throw unavailable();
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return total === 0 ? null : Buffer.concat(chunks, total);
}

export class FileClaudeLocalConfig implements ClaudeLocalConfigReader {
  constructor(private readonly path: string | null = claudeConfigPath(), private readonly maximumBytes = CLAUDE_LOCAL_CONFIG_BYTES) {}

  async read(workdir: McpServersWorkdir, names: ReadonlySet<string>, signal: AbortSignal): Promise<ClaudeStoredServers> {
    signal.throwIfAborted();
    if (names.size === 0) return new Map();
    if (this.path === null) throw unavailable();
    const handle = await opened(this.path);
    if (!handle) return new Map();
    let bytes: Buffer | null;
    try { bytes = await bounded(handle, this.maximumBytes, signal); }
    catch (error) { throw signal.aborted ? error : unavailable(); }
    finally { await handle.close(); }
    signal.throwIfAborted();
    if (bytes === null) return new Map();
    let config: unknown;
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw unavailable(); }
    return claudeLocalServers(config, workdir.cwd, names);
  }
}
