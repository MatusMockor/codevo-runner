import { RunnerError } from './contracts.js';
export type RepositoryProvider = 'github' | 'gitlab';
export type RepositoryHost = Readonly<{ provider: RepositoryProvider; host: string; auth: 'authenticated' | 'notAuthenticated' }>;
export type RepositoryHostsState = Readonly<{ status: 'ready'; hosts: readonly RepositoryHost[]; truncated: boolean }> | Readonly<{ status: 'cliMissing' }> | Readonly<{ status: 'failed'; reason: 'timedOut' | 'invalidOutput' | 'busy' }>;
export type RepositoryHostsSnapshot = Readonly<Record<RepositoryProvider, RepositoryHostsState>>;
export type RepositoryInfo = Readonly<{ provider: RepositoryProvider; host: string; fullPath: string; description: string | null; visibility: 'public' | 'private' | 'internal' | 'unknown'; defaultBranch: string | null; sshUrl: string | null; httpsUrl: string | null }>;
export type RepositoryFailure = Readonly<{ status: 'notFound' | 'cliMissing' | 'notAuthenticated' | 'hostNotAllowed' | 'timedOut' | 'superseded' }> | Readonly<{ status: 'rateLimited'; retryAfterSeconds: number | null }> | Readonly<{ status: 'failed'; reason: 'network' | 'invalidOutput' | 'outputTooLarge' | 'busy' | 'unknown' }>;
export type RepositoryLookupOutcome = Readonly<{ status: 'ok'; repository: RepositoryInfo }> | RepositoryFailure;
export type RepositorySearchOutcome = Readonly<{ status: 'ok'; repositories: readonly RepositoryInfo[]; nextPage: number | null; truncated: boolean }> | RepositoryFailure;
export type RepositoryLookupRequest = Readonly<{ provider: RepositoryProvider; host: string; path: string }>;
export type RepositorySearchRequest = Readonly<{ provider: RepositoryProvider; host: string; query: string; page: number }>;
export function validHost(value: unknown): value is string { return typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value); }
export function validPath(provider: RepositoryProvider, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255 || value.includes('..')) return false;
  const parts = value.split('/');
  return parts.length >= 2 && parts.length <= (provider === 'github' ? 2 : 20) && parts.every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  return value as Record<string, unknown>;
}
export function parseRepositoryRequest(value: unknown, search: false): RepositoryLookupRequest;
export function parseRepositoryRequest(value: unknown, search: true): RepositorySearchRequest;
export function parseRepositoryRequest(value: unknown, search: boolean): RepositoryLookupRequest | RepositorySearchRequest {
  const row = object(value);
  const keys = search ? ['provider', 'host', 'query', 'page'] : ['provider', 'host', 'path'];
  if (Object.keys(row).some(key => !keys.includes(key)) || (row.provider !== 'github' && row.provider !== 'gitlab') || !validHost(row.host)) throw new RunnerError('invalid_input');
  const { provider, host } = row;
  if (!search) {
    if (!validPath(provider, row.path)) throw new RunnerError('invalid_input');
    return { provider, host, path: row.path };
  }
  if (typeof row.query !== 'string' || row.query !== row.query.trim() || row.query.length > 100 || row.query.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._ /-]*$/.test(row.query) || !Number.isInteger(row.page) || typeof row.page !== 'number' || row.page < 1 || row.page > 10) throw new RunnerError('invalid_input');
  return { provider, host, query: row.query, page: row.page };
}
function bounded(value: unknown, max: number): string | null { return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, max).join('') : null; }
export function parseRepository(provider: RepositoryProvider, host: string, value: unknown): RepositoryInfo {
  const row = object(value);
  const fullPath = provider === 'github' ? row.full_name : row.path_with_namespace;
  if (!validPath(provider, fullPath)) throw new RunnerError('invalid_input');
  const visibility = row.visibility === 'public' || row.visibility === 'private' || row.visibility === 'internal' ? row.visibility : row.private === true ? 'private' : row.private === false ? 'public' : 'unknown';
  // Pin provider URLs to the authenticated host and discard credential-bearing URLs.
  return { provider, host, fullPath, description: bounded(row.description, 200), visibility, defaultBranch: branch(row.default_branch), sshUrl: provider === 'github' ? `git@${host}:${fullPath}.git` : pinnedCloneUrl(row.ssh_url_to_repo, host, true), httpsUrl: provider === 'github' ? `https://${host}/${fullPath}.git` : pinnedCloneUrl(row.http_url_to_repo, host, false) };
}

function pinnedCloneUrl(value: unknown, host: string, ssh: boolean): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[^\x21-\x7e]/.test(value) || /[\\?#]/.test(value)) return null;
  if (ssh && value.startsWith(`git@${host}:`)) {
    const path = value.slice(`git@${host}:`.length).replace(/\.git$/, '');
    return validPath('gitlab', path) ? value : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== (ssh ? 'ssh:' : 'https:') || url.hostname !== host || url.password || (ssh ? url.username !== 'git' : Boolean(url.username)) || url.search || url.hash) return null;
    if (!validPath('gitlab', url.pathname.slice(1).replace(/\.git$/, ''))) return null;
    return value;
  } catch { return null; }
}

function branch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 && value.length <= 255 && !/[\u0000- \u007f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.includes('//') && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && value !== '@' && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')) ? value : null;
}
