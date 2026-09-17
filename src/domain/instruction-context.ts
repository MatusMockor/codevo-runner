import { RunnerError } from './contracts.js';
import type { InstructionFile, InstructionSnapshot } from './instructions.js';

export function materializedInstructionPath(file: InstructionFile): string {
  if (file.scope === 'project') return file.path;
  return file.path.startsWith('rules/')
    ? `.claude/rules/codevo-global/${file.path.slice(6)}`
    : `.codevo-instructions/global/${file.path}`;
}

/** Closed snapshot imports may never fall back to unrelated files on the server. */
function resolveImport(source: InstructionFile, reference: string, files: readonly InstructionFile[]): InstructionFile {
  if (reference.startsWith('/') || reference.startsWith('~') || reference.includes('\\') || reference.includes('\0')) throw new RunnerError('invalid_input');
  if (!reference.toLowerCase().endsWith('.md')) throw new RunnerError('invalid_input');
  const components = source.path.split('/').slice(0, -1);
  for (const component of reference.split('/')) {
    if (component === '..') { if (!components.length) throw new RunnerError('invalid_input'); components.pop(); }
    else if (component !== '.') components.push(component);
  }
  const found = files.find(file => file.scope === source.scope && file.path === components.join('/'));
  if (!found) throw new RunnerError('invalid_input');
  return found;
}

function imports(content: string, replace: (path: string) => string): string {
  // Ignore examples in fenced/inline code; match the memory import syntax only.
  let fenced = false;
  return content.split('\n').map(line => {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.split(/(`[^`]*`)/u).map((part, index) => index % 2 ? part : part.replace(
      /(^|[\s(])@(?:"([^"\n]+)"|([^\s<>"`)'\]]*))(?=[\s)'\]]|$)/gu,
      (match, prefix: string, quoted: string | undefined, bare: string | undefined) => {
        const annotation = quoted === undefined && !line.trimStart().startsWith('@') &&
          bare !== undefined && bare.split('/').every(tag => ['param', 'var', 'throws'].includes(tag.replace(/^@+/u, '')));
        return annotation ? match : `${prefix}${replace(quoted ?? bare!)}`;
      },
    )).join('');
  }).join('\n');
}

function relativeImport(from: string, to: string): string {
  const left = from.split('/').slice(0, -1);
  const right = to.split('/');
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
  const path = [...left.map(() => '..'), ...right].join('/');
  return path.includes(' ') ? `@"${path}"` : `@${path}`;
}

export function materializedInstructionFiles(snapshot: InstructionSnapshot): readonly Readonly<{path: string; content: string}>[] {
  const paths = new Set<string>();
  return snapshot.files.map(file => {
    const path = materializedInstructionPath(file);
    const key = path.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new RunnerError('invalid_input');
    paths.add(key);
    const content = imports(file.content, reference => relativeImport(path, materializedInstructionPath(resolveImport(file, reference, snapshot.files))));
    return { path, content };
  });
}

export function instructionContext(snapshot: InstructionSnapshot): string {
  const root = snapshot.files.find(file => file.scope === 'global' && file.path === 'CLAUDE.md');
  const visited = new Set<string>();
  let expandedBytes = 0;
  function expand(file: InstructionFile, depth: number): string {
    if (depth > 32 || visited.has(file.path)) throw new RunnerError('invalid_input');
    visited.add(file.path);
    const result = imports(file.content, reference => expand(resolveImport(file, reference, snapshot.files), depth + 1));
    visited.delete(file.path);
    expandedBytes += new TextEncoder().encode(result).byteLength;
    if (expandedBytes > 1_048_576) throw new RunnerError('too_large');
    return result;
  }
  const global = root ? expand(root, 0) : '';
  const index = snapshot.files.filter(file => file.scope === 'global'
    ? file.path.startsWith('rules/')
    : /(^|\/)(CLAUDE(?:\.local)?\.md|AGENTS(?:\.override)?\.md)$/u.test(file.path) || /(^|\/)\.claude\/rules\/.+\.md$/iu.test(file.path))
    .map(file => `- ${JSON.stringify(materializedInstructionPath(file))} (${file.scope === 'global' ? 'global rule; preserve paths frontmatter' : 'project; preserve directory scope and paths frontmatter'})`).join('\n');
  return `[Codevo current instruction snapshot]\nThese are the current synchronized instructions for this turn; they replace earlier synchronized instruction snapshots in this conversation. Project rules take precedence over global rules. Read applicable files below before working. Nested project CLAUDE.md and CLAUDE.local.md apply only within their containing directory; rules with paths frontmatter apply only to matching paths. Imported supporting files are not independently global instructions. Do not apply a nested rule to unrelated directories.\n[Global CLAUDE.md]\n${global}\n[Instruction file index]\n${index || '(none)'}\n[End current instruction snapshot]\n`;
}
