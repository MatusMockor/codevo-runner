import { parseExecutionTimeoutMs } from './domain/execution-policy.js';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { RegisteredProject } from './domain/execution.js';

export function readConfig(env: NodeJS.ProcessEnv) {
  const host = env.CODEVO_HOST ?? '127.0.0.1';
  const portText = env.CODEVO_PORT ?? '4318';
  const name = env.CODEVO_NAME ?? 'Codevo runner';
  if (!isIP(host)) throw new Error('CODEVO_HOST must be an IP address');
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    throw new Error('CODEVO_PORT must be between 1 and 65535');
  if (!name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name))
    throw new Error('CODEVO_NAME must contain 1–100 printable characters');
  if (!env.CODEVO_TOKEN_FILE) throw new Error('CODEVO_TOKEN_FILE is required');
  const executionText = env.CODEVO_EXECUTION_ENABLED ?? 'false';
  if (executionText !== 'true' && executionText !== 'false')
    throw new Error('CODEVO_EXECUTION_ENABLED must be true or false');
  const executionIsolation = env.CODEVO_EXECUTION_ISOLATION ?? 'provider';
  if (executionIsolation !== 'provider' && executionIsolation !== 'container')
    throw new Error('CODEVO_EXECUTION_ISOLATION must be provider or container');
  if (env.CODEVO_PROJECTS_ROOT !== undefined && (!isAbsolute(env.CODEVO_PROJECTS_ROOT) || /[\x00-\x1f\x7f]/.test(env.CODEVO_PROJECTS_ROOT)))
    throw new Error('CODEVO_PROJECTS_ROOT must be an absolute path');
  return Object.freeze({ host, port: Number(portText), name,
    executionEnabled: executionText === 'true',
    executionTimeoutMs: parseExecutionTimeoutMs(env.CODEVO_EXECUTION_TIMEOUT_MS),
    executionIsolation,
    projectsRoot: resolve(env.CODEVO_PROJECTS_ROOT ?? `${homedir()}/Developer`),
    projectsFile: env.CODEVO_PROJECTS_FILE ? resolve(env.CODEVO_PROJECTS_FILE) : undefined,
    dataDir: resolve(env.CODEVO_DATA_DIR ?? '.codevo'),
    tokenFile: resolve(env.CODEVO_TOKEN_FILE) });
}

/** Host-owned registration: never read project paths from an HTTP request. */
export async function readProjectsFile(path: string): Promise<readonly RegisteredProject[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Invalid projects configuration file');
    const bytes = Buffer.alloc(65_537);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > 65_536) throw new Error('Projects configuration exceeds limit');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    if (!Array.isArray(value) || value.length > 32)
      throw new Error('Configure at most 32 projects');
    const ids = new Set<string>();
    return Object.freeze(value.map((entry: unknown): RegisteredProject => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid project');
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).sort().join(',') !== 'id,name,path' ||
          typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) ||
          ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 ||
          /[\x00-\x1f\x7f]/.test(item.name) || typeof item.path !== 'string' ||
          !isAbsolute(item.path) || item.path.length > 4096 || /[\x00-\x1f\x7f]/.test(item.path))
        throw new Error('Invalid project registration');
      ids.add(item.id);
      return Object.freeze({ id: item.id, name: item.name, path: item.path });
    }));
  } finally { await file.close(); }
}
