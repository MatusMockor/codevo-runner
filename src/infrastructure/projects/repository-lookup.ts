import { spawn } from 'node:child_process';
import type { RepositoryLookupPort } from '../../application/repository-lookup-service.js';
import { parseRepository, validHost, type RepositoryProvider, type RepositoryHostsState, type RepositoryHost, type RepositoryLookupRequest, type RepositoryLookupOutcome, type RepositorySearchRequest, type RepositorySearchOutcome, type RepositoryFailure } from '../../domain/repository-lookup.js';
export type CliResult = Readonly<{ code: number | null; stdout: string; stderr: string; failure?: 'cliMissing' | 'timedOut' | 'outputTooLarge' | 'invalidOutput' }>;
export type RepositoryCli = (program: 'gh' | 'glab', args: readonly string[], signal: AbortSignal) => Promise<CliResult>;
export const runRepositoryCli: RepositoryCli = (program, args, signal) => new Promise(resolve => {
  signal.throwIfAborted();
  const child = spawn(program, [...args], { cwd: '/', shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CLICOLOR: '0', GLAB_CHECK_UPDATE: 'false' } });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  let failure: CliResult['failure'];
  const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already reaped */ } };
  const stop = () => { failure = 'timedOut'; kill(); };
  const timer = setTimeout(stop, 15_000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const collect = (chunk: Buffer, error: boolean) => {
    const current = error ? stderr : stdout;
    const max = error ? 65_536 : 262_144;
    if (current.length + chunk.length > max) { failure = 'outputTooLarge'; kill(); return; }
    if (error) stderr = Buffer.concat([current, chunk]); else stdout = Buffer.concat([current, chunk]);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
  child.once('exit', kill);
  child.once('error', (error: NodeJS.ErrnoException) => { failure = error.code === 'ENOENT' ? 'cliMissing' : 'timedOut'; });
  child.once('close', code => { clearTimeout(timer); signal.removeEventListener('abort', stop); let text = ''; try { text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); } catch { failure = 'invalidOutput'; } resolve({ code, stdout: text, stderr: stderr.toString('utf8'), ...(failure ? { failure } : {}) }); });
});
function failure(result: CliResult): RepositoryFailure | null {
  if (result.failure === 'cliMissing' || result.failure === 'timedOut') return { status: result.failure };
  if (result.failure) return { status: 'failed', reason: result.failure };
  if (result.code === 0) return null;
  if (/\b429\b|rate limit/i.test(result.stderr)) return { status: 'rateLimited', retryAfterSeconds: null };
  if (/\b401\b|not logged|authentication/i.test(result.stderr)) return { status: 'notAuthenticated' };
  if (/\b404\b|not found/i.test(result.stderr)) return { status: 'notFound' };
  return { status: 'failed', reason: 'network' };
}
export class CliRepositoryLookup implements RepositoryLookupPort {
  constructor(private readonly run: RepositoryCli = runRepositoryCli) {}
  async hosts(provider: RepositoryProvider, signal: AbortSignal): Promise<RepositoryHostsState> {
    const result = await this.run(provider === 'github' ? 'gh' : 'glab', provider === 'github' ? ['auth', 'status', '--hostname', 'github.com'] : ['auth', 'status'], signal);
    if (result.failure === 'cliMissing') return { status: 'cliMissing' };
    if (result.failure) return { status: 'failed', reason: result.failure === 'timedOut' ? 'timedOut' : 'invalidOutput' };
    if (provider === 'github') return { status: 'ready', hosts: [{ provider, host: 'github.com', auth: result.code === 0 ? 'authenticated' : 'notAuthenticated' }], truncated: false };
    const hosts: RepositoryHost[] = [];
    let host: string | null = null;
    let truncated = false;
    const lines = `${result.stdout}\n${result.stderr}`.split('\n');
    for (const line of lines.slice(0, 512)) {
      if (!/^\s/.test(line)) {
        const candidate = line.trim().replace(/:$/, '').toLowerCase();
        host = validHost(candidate) ? candidate : null;
        if (host && !hosts.some(item => item.host === host)) {
          if (hosts.length >= 8) { truncated = true; host = null; }
          else hosts.push({ provider, host, auth: 'notAuthenticated' });
        }
      } else if (host && line.toLowerCase().includes(`logged in to ${host} as`)) {
        const index = hosts.findIndex(item => item.host === host);
        if (index >= 0) hosts[index] = { provider, host, auth: 'authenticated' };
      }
    }
    return { status: 'ready', hosts, truncated: truncated || lines.length > 512 };
  }
  async lookup(request: RepositoryLookupRequest, signal: AbortSignal): Promise<RepositoryLookupOutcome> {
    const { provider, host, path } = request;
    const endpoint = provider === 'github' ? `repos/${path}` : `projects/${encodeURIComponent(path)}`;
    const result = await this.run(provider === 'github' ? 'gh' : 'glab', ['api', '--hostname', host, endpoint], signal);
    const error = failure(result); if (error) return error;
    try { return { status: 'ok', repository: parseRepository(provider, host, JSON.parse(result.stdout)) }; }
    catch { return { status: 'failed', reason: 'invalidOutput' }; }
  }
  async search(request: RepositorySearchRequest, signal: AbortSignal): Promise<RepositorySearchOutcome> {
    const { provider, host, query, page } = request;
    const endpoint = provider === 'github' ? `search/repositories?q=${encodeURIComponent(query + ' in:name fork:true')}&per_page=20&page=${page}` : `projects?membership=true&search=${encodeURIComponent(query)}&per_page=20&page=${page}&order_by=id&sort=asc`;
    const result = await this.run(provider === 'github' ? 'gh' : 'glab', ['api', '--hostname', host, endpoint], signal);
    const error = failure(result); if (error) return error;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      const row = parsed as { items?: unknown; total_count?: unknown; incomplete_results?: unknown };
      const items = provider === 'github' ? row?.items : parsed;
      if (!Array.isArray(items) || items.length > 20) throw new Error('Invalid result');
      if (provider === 'github' && (typeof row.total_count !== 'number' || !Number.isSafeInteger(row.total_count) || row.total_count < 0 || typeof row.incomplete_results !== 'boolean')) throw new Error('Invalid count');
      const more = provider === 'github' ? (row.total_count as number) > page * 20 : items.length === 20;
      return { status: 'ok', repositories: items.map(item => parseRepository(provider, host, item)), nextPage: more && page < 10 ? page + 1 : null, truncated: row?.incomplete_results === true || (more && page === 10) };
    } catch { return { status: 'failed', reason: 'invalidOutput' }; }
  }
}
