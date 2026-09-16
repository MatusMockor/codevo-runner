import { RunnerError } from './contracts.js';

export const INSTRUCTION_LIMITS = Object.freeze({ files: 128, fileBytes: 65_536, totalBytes: 524_288, pathBytes: 512, depth: 32 });
export type InstructionFile = Readonly<{ scope: 'global' | 'project'; path: string; content: string }>;
export type InstructionSnapshot = Readonly<{ version: 1; files: readonly InstructionFile[] }>;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('invalid_input');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))) throw new RunnerError('invalid_input');
  return result;
}

/** Validate and copy the snapshot, so caller mutations cannot alter admitted rules. */
export function parseInstructionSnapshot(value: unknown): InstructionSnapshot {
  const input = record(value, ['version', 'files']);
  if (input.version !== 1 || !Array.isArray(input.files)) throw new RunnerError('invalid_input');
  if (input.files.length > INSTRUCTION_LIMITS.files) throw new RunnerError('too_large');
  const encoder = new TextEncoder();
  const paths = new Set<string>();
  let total = 0;
  const files = input.files.map((item: unknown): InstructionFile => {
    const file = record(item, ['scope', 'path', 'content']);
    if ((file.scope !== 'global' && file.scope !== 'project') || typeof file.path !== 'string' || typeof file.content !== 'string') throw new RunnerError('invalid_input');
    const segments = file.path.split('/');
    if (!file.path || /[\\\u0000-\u001f\u007f:]/.test(file.path) || !file.path.toLowerCase().endsWith('.md') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '))) throw new RunnerError('invalid_input');
    if (file.path.length > INSTRUCTION_LIMITS.pathBytes || encoder.encode(file.path).length > INSTRUCTION_LIMITS.pathBytes || segments.length > INSTRUCTION_LIMITS.depth) throw new RunnerError('too_large');
    const key = `${file.scope}/${file.path.normalize('NFC').toLowerCase()}`;
    if (paths.has(key) || [...paths].some(path => path.startsWith(`${key}/`) || key.startsWith(`${path}/`))) throw new RunnerError('invalid_input');
    paths.add(key);
    if (file.content.length > INSTRUCTION_LIMITS.fileBytes) throw new RunnerError('too_large');
    const bytes = encoder.encode(file.content).length;
    total += bytes;
    if (bytes > INSTRUCTION_LIMITS.fileBytes || total > INSTRUCTION_LIMITS.totalBytes) throw new RunnerError('too_large');
    return Object.freeze({ scope: file.scope, path: file.path, content: file.content });
  });
  // Stable ordering gives retries identical fingerprints regardless of discovery order.
  files.sort((left, right) => left.scope.localeCompare(right.scope) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({ version: 1, files: Object.freeze(files) });
}
