import { isIP } from 'node:net';
import { resolve } from 'node:path';

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
  return Object.freeze({ host, port: Number(portText), name,
    dataDir: resolve(env.CODEVO_DATA_DIR ?? '.codevo'),
    tokenFile: resolve(env.CODEVO_TOKEN_FILE) });
}
