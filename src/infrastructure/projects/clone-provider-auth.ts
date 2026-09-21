import type { RepositoryLookupPort } from '../../application/repository-lookup-service.js';
import { validHost } from '../../domain/repository-lookup.js';
import { CliRepositoryLookup } from './repository-lookup.js';

/** Tokens stay inside the provider CLI's Git credential protocol, never in Runner state. */
export async function prepareCloneProviderAuth(
  cloneUrl: string,
  signal: AbortSignal,
  lookup: Pick<RepositoryLookupPort, 'hosts'> = new CliRepositoryLookup(),
): Promise<readonly string[]> {
  signal.throwIfAborted();
  let url: URL;
  try { url = new URL(cloneUrl); } catch { return []; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !validHost(url.hostname) || cloneUrl.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(cloneUrl)) return [];
  const host = url.hostname;
  const provider = host === 'github.com' ? 'github' : 'gitlab';
  const state = await lookup.hosts(provider, signal);
  signal.throwIfAborted();
  if (state.status !== 'ready' || !state.hosts.some(item => item.provider === provider && item.host === host && item.auth === 'authenticated')) return [];
  // The command is a fixed implementation, never a caller-provided command/configuration.
  // Keep it host-scoped even though redirects are disabled: Git must not reuse this
  // helper for another authority, and global/user helpers remain cleared by clone.ts.
  const helper = provider === 'github' ? '!gh auth git-credential' : '!glab auth git-credential';
  return ['-c', 'http.followRedirects=false', '-c', `credential.https://${host}.helper=${helper}`];
}
