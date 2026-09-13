import { RunnerError } from '../../domain/contracts.js';
import { WORKSPACE_FILE_LIMITS, validateWorkspacePath, type WorkspaceFile, type WorkspaceFileDiff, type WorkspaceFiles } from '../../domain/workspace-files.js';
import { git } from './git-command.js';
import { readSafeWorkspaceFile } from './safe-workspace-read.js';

/** Git supplies names and baseline blobs; the descriptor-backed reader supplies current text. */
export async function listWorkspaceFiles(cwd: string, base: string, signal: AbortSignal, identity: Readonly<{ dev: number; ino: number }>): Promise<WorkspaceFiles> {
  const tracked = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, '--'], signal, identity);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--'], signal, identity);
  const trackedNames = decodeNames(tracked.bytes);
  const untrackedNames = decodeNames(untracked.bytes);
  const records = trackedNames.records;
  const files: WorkspaceFile[] = [];
  let bytes = 0;
  let truncated = tracked.truncated || untracked.truncated || trackedNames.invalid || untrackedNames.invalid;
  const add = (file: WorkspaceFile) => {
    try { validateWorkspacePath(file.path); if (file.oldPath) validateWorkspacePath(file.oldPath); }
    catch { truncated = true; return; }
    const previous = files.findIndex(candidate => candidate.path === file.path);
    if (previous >= 0) {
      if (files[previous]?.status === 'deleted' && file.status === 'untracked') files[previous] = { path: file.path, status: 'modified' };
      return;
    }
    const size = Buffer.byteLength(JSON.stringify(file));
    if (files.length >= WORKSPACE_FILE_LIMITS.files || bytes + size > WORKSPACE_FILE_LIMITS.listBytes) { truncated = true; return; }
    bytes += size;
    files.push(file);
  };
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    const path = records[index++];
    if (status?.startsWith('R')) {
      const destination = records[index++];
      if (!path || !destination) { truncated = true; continue; }
      add({ path: destination, oldPath: path, status: 'renamed' });
      continue;
    }
    if (!path) { truncated = true; continue; }
    if (status === 'A') { add({ path, status: 'added' }); continue; }
    if (status === 'D') { add({ path, status: 'deleted' }); continue; }
    if (status === 'M' || status === 'T' || status === 'U') { add({ path, status: 'modified' }); continue; }
    truncated = true;
  }
  for (const path of untrackedNames.records) if (path) add({ path, status: 'untracked' });
  return { files, truncated };
}

export async function readWorkspaceFileDiff(cwd: string, expected: Readonly<{ dev: number; ino: number }>, base: string, path: string, signal: AbortSignal): Promise<WorkspaceFileDiff> {
  validateWorkspacePath(path);
  const listing = await listWorkspaceFiles(cwd, base, signal, expected);
  const file = listing.files.find(candidate => candidate.path === path);
  if (!file) throw new RunnerError('not_found');
  const modified = await readSafeWorkspaceFile({ cwd, expected, path });
  signal.throwIfAborted();
  const original = await originalContent(cwd, base, file, signal, expected);
  const reason = original.unavailableReason ?? modified.unavailableReason;
  if (reason) {
    const empty = { text: '', truncated: reason === 'large' };
    return { path, original: empty, modified: empty, unavailableReason: reason };
  }
  return { path, original: { text: original.text, truncated: false }, modified: { text: modified.text, truncated: false }, unavailableReason: null };
}

async function originalContent(cwd: string, base: string, file: WorkspaceFile, signal: AbortSignal, identity: Readonly<{ dev: number; ino: number }>) {
  if (file.status === 'added' || file.status === 'untracked') return { text: '', unavailableReason: null };
  const object = `${base}:${file.oldPath ?? file.path}`;
  const size = await git(cwd, ['cat-file', '-s', object], signal, identity);
  if (size.truncated || !/^\d+\n$/.test(size.text)) throw new RunnerError('storage_unavailable');
  if (Number(size.text.trim()) > WORKSPACE_FILE_LIMITS.textBytes) return { text: '', unavailableReason: 'large' as const };
  const blob = await git(cwd, ['cat-file', 'blob', object], signal, identity);
  if (blob.truncated || blob.bytes.length > WORKSPACE_FILE_LIMITS.textBytes) return { text: '', unavailableReason: 'large' as const };
  if (blob.bytes.includes(0)) return { text: '', unavailableReason: 'binary' as const };
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob.bytes), unavailableReason: null }; }
  catch { return { text: '', unavailableReason: 'binary' as const }; }
}

function decodeNames(bytes: Buffer): { records: (string | null)[]; invalid: boolean } {
  const records: (string | null)[] = [];
  let start = 0;
  let invalid = false;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    try { records.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end))); }
    catch { records.push(null); invalid = true; }
    start = end + 1;
  }
  return { records, invalid };
}
