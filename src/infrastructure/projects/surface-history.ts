import { RunnerError } from '../../domain/contracts.js';
import { validateWorkspacePath, WORKSPACE_FILE_LIMITS, type WorkspaceFileDiff } from '../../domain/workspace-files.js';
import { git } from './git-command.js';

type Identity = Readonly<{ dev: number; ino: number }>;
export type SurfaceHistory = Readonly<{ commits: readonly Readonly<{ id: string; parents: readonly string[]; subject: string; authorName: string; authoredAt: string }>[]; nextOffset: number | null; truncated: boolean }>;
export type SurfaceCommitFiles = Readonly<{ files: readonly Readonly<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; oldPath?: string }>[]; truncated: boolean }>;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function listSurfaceHistory(cwd: string, identity: Identity, input: Readonly<{ offset: number }>, signal: AbortSignal): Promise<SurfaceHistory> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 100_000) throw new RunnerError('invalid_input');
  const result = await git(cwd, ['log', '-z', '--format=%H%x00%P%x00%s%x00%an%x00%aI', '--max-count=51', `--skip=${input.offset}`, 'HEAD', '--'], signal, identity);
  const fields = result.text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const commits: SurfaceHistory['commits'][number][] = [];
  let truncated = result.truncated || fields.length % 5 !== 0;
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [id, parents, subject, authorName, authoredAt] = fields.slice(index, index + 5);
    if (!id || !HASH.test(id) || parents === undefined || subject === undefined || authorName === undefined || !authoredAt) { truncated = true; break; }
    const parentIds = parents ? parents.split(' ') : [];
    if (parentIds.some(parent => !HASH.test(parent)) || !Number.isFinite(Date.parse(authoredAt))) { truncated = true; break; }
    commits.push({ id, parents: parentIds, subject, authorName, authoredAt });
  }
  const hasNext = commits.length > 50 || result.truncated;
  const page = commits.slice(0, 50);
  return { commits: page, nextOffset: hasNext && page.length > 0 && input.offset + page.length <= 100_000 ? input.offset + page.length : null, truncated: truncated || (hasNext && input.offset + page.length > 100_000) };
}

async function parentOf(cwd: string, identity: Identity, commit: string, signal: AbortSignal): Promise<string | null> {
  if (!HASH.test(commit)) throw new RunnerError('invalid_input');
  try { await git(cwd, ['merge-base', '--is-ancestor', commit, 'HEAD'], signal, identity); }
  catch { signal.throwIfAborted(); throw new RunnerError('not_found'); }
  const result = await git(cwd, ['show', '-s', '--format=%P', commit, '--'], signal, identity);
  if (result.truncated) throw new RunnerError('storage_unavailable');
  const parents = result.text.trim();
  if (!parents) return null;
  const parent = parents.split(' ')[0];
  if (!parent || !HASH.test(parent)) throw new RunnerError('storage_unavailable');
  return parent;
}

async function commitFiles(cwd: string, identity: Identity, commit: string, parent: string | null, signal: AbortSignal): Promise<SurfaceCommitFiles> {
  const args = parent ? ['diff', parent, commit] : ['diff-tree', '--root', '--no-commit-id', '-r', commit];
  const result = await git(cwd, [...args, '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', '--'], signal, identity);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes); }
  catch { throw new RunnerError('storage_unavailable'); }
  const records = text.split('\0');
  let truncated = result.truncated || records.at(-1) !== '';
  records.pop();
  const files: SurfaceCommitFiles['files'][number][] = [];
  let bytes = 0;
  for (let index = 0; index < records.length;) {
    const code = records[index++];
    const source = records[index++];
    const renamed = code?.startsWith('R');
    const path = renamed ? records[index++] : source;
    if (!path || !source) { truncated = true; break; }
    try { validateWorkspacePath(source); validateWorkspacePath(path); } catch { truncated = true; continue; }
    const status = renamed ? 'renamed' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' || code === 'T' ? 'modified' : null;
    if (!status) { truncated = true; continue; }
    const file: SurfaceCommitFiles['files'][number] = { path, status, ...(renamed ? { oldPath: source } : {}) };
    bytes += Buffer.byteLength(JSON.stringify(file));
    if (files.length >= WORKSPACE_FILE_LIMITS.files || bytes > WORKSPACE_FILE_LIMITS.listBytes) { truncated = true; break; }
    files.push(file);
  }
  return { files, truncated };
}

export async function listSurfaceCommitFiles(cwd: string, identity: Identity, input: Readonly<{ commit: string }>, signal: AbortSignal): Promise<SurfaceCommitFiles> {
  return commitFiles(cwd, identity, input.commit, await parentOf(cwd, identity, input.commit, signal), signal);
}

async function blob(cwd: string, identity: Identity, commit: string | null, path: string, signal: AbortSignal) {
  if (commit === null) return { text: '', reason: null };
  const object = `${commit}:${path}`;
  const size = await git(cwd, ['cat-file', '-s', object], signal, identity);
  if (size.truncated || !/^\d+\n$/.test(size.text)) throw new RunnerError('storage_unavailable');
  if (Number(size.text.trim()) > WORKSPACE_FILE_LIMITS.textBytes) return { text: '', reason: 'large' as const };
  const result = await git(cwd, ['cat-file', 'blob', object], signal, identity);
  if (result.truncated || result.bytes.length > WORKSPACE_FILE_LIMITS.textBytes) return { text: '', reason: 'large' as const };
  if (result.bytes.includes(0)) return { text: '', reason: 'binary' as const };
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes), reason: null }; }
  catch { return { text: '', reason: 'binary' as const }; }
}

export async function readSurfaceCommitDiff(cwd: string, identity: Identity, input: Readonly<{ commit: string; path: string }>, signal: AbortSignal): Promise<WorkspaceFileDiff> {
  const path = validateWorkspacePath(input.path);
  const parent = await parentOf(cwd, identity, input.commit, signal);
  const listing = await commitFiles(cwd, identity, input.commit, parent, signal);
  const file = listing.files.find(candidate => candidate.path === path);
  if (!file) throw new RunnerError('not_found');
  const original = await blob(cwd, identity, file.status === 'added' ? null : parent, file.oldPath ?? path, signal);
  const modified = await blob(cwd, identity, file.status === 'deleted' ? null : input.commit, path, signal);
  const unavailableReason = original.reason ?? modified.reason;
  return { path, original: { text: unavailableReason ? '' : original.text, truncated: unavailableReason === 'large' }, modified: { text: unavailableReason ? '' : modified.text, truncated: unavailableReason === 'large' }, unavailableReason };
}
