export type CommandCatalogProvider = 'claudeCode' | 'codex';
export type CommandCatalogKind = 'command' | 'skill';
export type CommandCatalogEntry = Readonly<{
  kind: CommandCatalogKind; name: string; label: string | null; description: string | null;
  argumentHint: string | null; builtin: boolean;
}>;
export type CommandCatalog = Readonly<{
  version: 1; provider: CommandCatalogProvider; truncated: boolean; entries: readonly CommandCatalogEntry[];
}>;

export const COMMAND_CATALOG_LIMITS = Object.freeze({
  maxEntries: 512, maxNameBytes: 128, maxLabelBytes: 128, maxDescriptionBytes: 512, maxArgumentHintBytes: 128,
  outputBytes: 2 * 1024 * 1024,
});
export const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

const ENVELOPE_KEYS = ['version', 'provider', 'truncated', 'entries'] as const;
const ENTRY_KEYS = ['kind', 'name', 'label', 'description', 'argumentHint', 'builtin'] as const;
const encoder = new TextEncoder();

function invalid(): never { throw new Error('invalid_command_catalog'); }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function object(value: unknown): Record<string, unknown> {
  return record(value) ?? invalid();
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= COMMAND_CATALOG_LIMITS.maxNameBytes &&
    COMMAND_NAME_PATTERN.test(value) && !value.startsWith('__');
}
function validText(value: unknown, maximum: number): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    encoder.encode(value).length <= maximum && !/[\p{Cc}\p{Cs}]/u.test(value);
}

export function commandCatalogKind(provider: CommandCatalogProvider): CommandCatalogKind {
  return provider === 'claudeCode' ? 'command' : 'skill';
}

/** Whitespace and control runs become one space; truncation never splits a code point. */
export function sanitizeCatalogText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\p{Cs}/gu, '�').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (encoder.encode(text).length <= maximum) return text || null;
  let size = 0, end = 0;
  for (const character of text) {
    const length = encoder.encode(character).length;
    if (size + length > maximum) break;
    size += length;
    end += character.length;
  }
  return text.slice(0, end).trimEnd() || null;
}

/** Validate the closed outbound contract, independently of provider output parsing. */
export function validateCommandCatalog(value: unknown): CommandCatalog {
  const row = object(value);
  if (!exactKeys(row, ENVELOPE_KEYS) || row.version !== 1 || !(row.provider === 'claudeCode' || row.provider === 'codex') ||
      typeof row.truncated !== 'boolean' || !Array.isArray(row.entries) || row.entries.length > COMMAND_CATALOG_LIMITS.maxEntries) invalid();
  const kind = commandCatalogKind(row.provider);
  const names = new Set<string>();
  for (const raw of row.entries) {
    const entry = object(raw);
    if (!exactKeys(entry, ENTRY_KEYS) || entry.kind !== kind || !validName(entry.name) || names.has(entry.name) ||
        typeof entry.builtin !== 'boolean' || !validText(entry.label, COMMAND_CATALOG_LIMITS.maxLabelBytes) ||
        !validText(entry.description, COMMAND_CATALOG_LIMITS.maxDescriptionBytes) ||
        !validText(entry.argumentHint, COMMAND_CATALOG_LIMITS.maxArgumentHintBytes)) invalid();
    names.add(entry.name);
  }
  return row as unknown as CommandCatalog;
}

function assemble(provider: CommandCatalogProvider, candidates: readonly (CommandCatalogEntry | null)[], incomplete = false): CommandCatalog {
  const names = new Set<string>();
  const entries: CommandCatalogEntry[] = [];
  let truncated = incomplete;
  for (const entry of candidates) {
    if (!entry || !validName(entry.name) || names.has(entry.name)) continue;
    if (entries.length === COMMAND_CATALOG_LIMITS.maxEntries) { truncated = true; break; }
    names.add(entry.name);
    entries.push(entry);
  }
  return validateCommandCatalog({ version: 1, provider, truncated, entries });
}

function jsonLine(line: string): Record<string, unknown> | null {
  try { return record(JSON.parse(line)); } catch { return null; }
}
function firstText(...values: readonly unknown[]): unknown {
  return values.find(value => typeof value === 'string');
}

/** Reads only `commands` from the matching initialize reply; account fields are never copied. */
export function parseClaudeCommands(output: string, requestId: string): CommandCatalog {
  let body: Record<string, unknown> | null = null;
  for (const line of output.split('\n')) {
    const message = jsonLine(line);
    const response = message?.type === 'control_response' ? record(message.response) : null;
    if (response?.request_id !== requestId) continue;
    body = response;
    break;
  }
  if (!body || body.subtype !== 'success') invalid();
  const commands = record(body.response)?.commands;
  if (!Array.isArray(commands)) invalid();
  return assemble('claudeCode', commands.map(raw => {
    const command = record(raw);
    if (!command || typeof command.name !== 'string') return null;
    return { kind: 'command', name: command.name, label: null,
      description: sanitizeCatalogText(command.description, COMMAND_CATALOG_LIMITS.maxDescriptionBytes),
      argumentHint: sanitizeCatalogText(command.argumentHint, COMMAND_CATALOG_LIMITS.maxArgumentHintBytes),
      builtin: command.builtin === true };
  }));
}

/** Maps the single `skills/list` listing of exactly this working directory. Skill paths and
 * load error details are never copied; skills that failed to load mark the catalog truncated. */
export function parseCodexSkills(result: unknown, cwd: string): CommandCatalog {
  const data = object(result).data;
  if (!Array.isArray(data)) invalid();
  const listings = data.filter(item => record(item)?.cwd === cwd);
  const listing = listings.length === 1 ? record(listings[0]) : null;
  if (!listing || !Array.isArray(listing.skills)) invalid();
  const incomplete = Array.isArray(listing.errors) && listing.errors.length > 0;
  return assemble('codex', listing.skills.map(raw => {
    const skill = record(raw);
    if (!skill || skill.enabled === false || typeof skill.name !== 'string') return null;
    const face = record(skill.interface);
    return { kind: 'skill', name: skill.name,
      label: sanitizeCatalogText(face?.displayName, COMMAND_CATALOG_LIMITS.maxLabelBytes),
      description: sanitizeCatalogText(firstText(skill.shortDescription, face?.shortDescription, skill.description), COMMAND_CATALOG_LIMITS.maxDescriptionBytes),
      argumentHint: null, builtin: skill.scope === 'system' };
  }), incomplete);
}
