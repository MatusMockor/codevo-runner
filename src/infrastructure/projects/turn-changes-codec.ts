import { validateWorkspacePath } from '../../domain/workspace-files.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && value.length <= bytes && Buffer.byteLength(value) <= bytes;
function path(value: unknown): value is string {
  try { return typeof value === 'string' && value.split('/').length <= 64 && !value.includes(':') && !/[\x7f-\x9f]/.test(value) && validateWorkspacePath(value) === value; }
  catch { return false; }
}
export function validSnapshot(value: unknown): boolean {
  if (!record(value) || !exact(value, ['files']) || !Array.isArray(value.files) || value.files.length > 8192) return false;
  const names = new Set<string>(); let total = 0;
  return value.files.every((file: unknown) => {
    if (!record(file) || !exact(file, ['path', 'hash', 'executable', 'text', 'unavailable']) || !path(file.path) || names.has(file.path) ||
        typeof file.executable !== 'boolean' || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash) || !text(file.text, 131072) ||
        ![null, 'binary', 'large'].includes(file.unavailable as string | null) || (file.unavailable !== null && file.text !== '')) return false;
    names.add(file.path); total += Buffer.byteLength(file.text); return total <= 8388608;
  });
}
export function validStoredTurn(value: unknown, taskId: string, start: boolean): boolean {
  if (!record(value)) return false;
  if (start) return exact(value, ['cwd', 'identity', 'snapshot']) && text(value.cwd, 16384) && value.cwd.startsWith('/') &&
    record(value.identity) && exact(value.identity, ['dev', 'ino']) && ['dev', 'ino'].every(key => Number.isSafeInteger(value.identity && (value.identity as Record<string, unknown>)[key]) && Number((value.identity as Record<string, unknown>)[key]) >= 0) && validSnapshot(value.snapshot);
  if (!exact(value, ['summary', 'diffs']) || !record(value.summary) || !exact(value.summary, ['turnId', 'state', 'files', 'truncated', 'reason']) || !Array.isArray(value.diffs)) return false;
  const summary = value.summary;
  if (summary.turnId !== taskId || !['ready', 'unavailable'].includes(String(summary.state)) || typeof summary.truncated !== 'boolean' ||
      !(summary.reason === null || text(summary.reason, 1024)) || !Array.isArray(summary.files) || summary.files.length > 500 || value.diffs.length !== summary.files.length) return false;
  if (summary.state === 'unavailable') return summary.files.length === 0 && summary.truncated === false && typeof summary.reason === 'string';
  const names = new Set<string>();
  return summary.files.every((file: unknown, index: number) => {
    const diff: unknown = (value.diffs as unknown[])[index];
    if (!record(file) || !exact(file, ['relativePath', 'oldRelativePath', 'status', 'addedLines', 'deletedLines']) || !path(file.relativePath) || names.has(file.relativePath) ||
        !(file.oldRelativePath === null || path(file.oldRelativePath)) || !['added','modified','deleted','renamed','untracked','conflicted'].includes(String(file.status)) ||
        !record(diff) || !exact(diff, ['relativePath','original','modified','unavailableReason']) || diff.relativePath !== file.relativePath || ![null,'binary','large'].includes(diff.unavailableReason as string | null)) return false;
    if (file.status === 'renamed' ? file.oldRelativePath === null || file.oldRelativePath === file.relativePath : file.oldRelativePath !== null) return false;
    names.add(file.relativePath);
    if (!['original','modified'].every(key => { const side = diff[key]; return record(side) && exact(side,['text','truncated']) && text(side.text,131072) && typeof side.truncated === 'boolean'; })) return false;
    return diff.unavailableReason === null ? ['addedLines','deletedLines'].every(key => Number.isSafeInteger(file[key]) && Number(file[key]) >= 0) : file.addedLines === null && file.deletedLines === null;
  });
}
