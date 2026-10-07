export const MCP_SERVERS_CAPABILITY = 'mcpServers';
export const MCP_SERVER_STATUSES = ['connected', 'connecting', 'needsAuth', 'failed', 'disabled', 'unknown'] as const;
export const MCP_SERVER_SCOPES = ['user', 'project', 'local', 'account', 'plugin', 'managed', 'unknown'] as const;
export const MCP_SERVER_TRANSPORTS = ['stdio', 'http', 'sse', 'unknown'] as const;
export type McpServersProvider = 'claude' | 'codex';
export type McpServerStatus = typeof MCP_SERVER_STATUSES[number];
export type McpServerScope = typeof MCP_SERVER_SCOPES[number];
export type McpServerTransport = typeof MCP_SERVER_TRANSPORTS[number];
export type McpServer = Readonly<{
  name: string; status: McpServerStatus; scope: McpServerScope; transport: McpServerTransport;
  endpointOrigin: string | null; toolCount: number | null; detail: string | null;
}>;
export type McpServers = Readonly<{
  version: 1; provider: McpServersProvider; truncated: boolean; servers: readonly McpServer[];
}>;

export const MCP_SERVERS_LIMITS = Object.freeze({
  maxServers: 128, maxNameBytes: 128, maxEndpointOriginBytes: 256, maxDetailBytes: 256, maxToolCount: 4096,
});
export const MCP_ENDPOINT_ORIGIN_PATTERN = /^https?:\/\/[^/?#@\s]+$/;

const ENVELOPE_KEYS = ['version', 'provider', 'truncated', 'servers'] as const;
const SERVER_KEYS = ['name', 'status', 'scope', 'transport', 'endpointOrigin', 'toolCount', 'detail'] as const;
const MAX_RAW_DETAIL_BYTES = 4096;
const MIN_NUMBERED_TOKEN_RUN = 16;
const MIN_OPAQUE_TOKEN_RUN = 32;
const REDACTED = '[redacted]';
const BIDI_CONTROL = /[‎‏‪-‮⁦-⁩]/u;
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/gu;
const LONE_SURROGATES = /\p{Cs}/gu;
const CONTROL = /[\p{Cc}\p{Cs}]/u;
const EDGE_SPACE = /^\p{White_Space}|\p{White_Space}$/u;
const TRAILING_SPACE = /\p{White_Space}+$/u;
const VISIBLE = /\P{White_Space}/u;
const WORD_SEPARATORS = /[\p{White_Space}\p{Cc}]+/u;
const WRAPPING_PUNCTUATION = /^["'`()[\]{}<>,;:.!?]+|["'`()[\]{}<>,;:.!?]+$/g;
const OPTION = /^-+[A-Za-z0-9]/;
const NEGATIVE_NUMBER = /^-[0-9.]*[0-9][0-9.]*$/;
const PATH_OR_ASSIGNMENT = /[/\\=@]/;
const NON_TOKEN = /[^A-Za-z0-9_+-]+/;
const SCHEME_TAIL = /[A-Za-z0-9+.-]*$/;
const HTTP_URL = /^([Hh][Tt][Tt][Pp][Ss]?):\/\/([^/?#\\]*)/;
const HOST_NAME = /^[A-Za-z0-9._-]+$/;
const IPV6_LITERAL = /^[0-9A-Fa-f:.]+$/;
const PORT = /^[0-9]{1,5}$/;

const CLAUDE_STATUSES: ReadonlyMap<string, McpServerStatus> = new Map([
  ['connected', 'connected'], ['pending', 'connecting'], ['needs-auth', 'needsAuth'], ['failed', 'failed'], ['disabled', 'disabled'],
]);
const CLAUDE_SCOPES: ReadonlyMap<string, McpServerScope> = new Map([
  ['user', 'user'], ['project', 'project'], ['local', 'local'], ['claudeai', 'account'], ['managed', 'managed'], ['enterprise', 'managed'],
]);
const CLAUDE_TRANSPORTS: ReadonlyMap<string, McpServerTransport> = new Map([
  ['stdio', 'stdio'], ['http', 'http'], ['claudeai-proxy', 'http'], ['sse', 'sse'],
]);
const CODEX_RUNTIME_STATUSES: ReadonlyMap<string, McpServerStatus> = new Map([
  ['connected', 'connected'], ['starting', 'connecting'], ['authenticationRequired', 'needsAuth'], ['failed', 'failed'],
  ['cancelled', 'failed'], ['disabled', 'disabled'], ['notStarted', 'unknown'],
]);
const encoder = new TextEncoder();

function invalid(): never { throw new Error('invalid_mcp_servers'); }
export function mcpRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}
function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some(candidate => candidate === value);
}
function mapped<T>(table: ReadonlyMap<string, T>, value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  return table.get(value) ?? fallback;
}
function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}
function withinBytes(value: string, maximum: number): boolean {
  return value.length <= maximum && encoder.encode(value).length <= maximum;
}
function boundedText(value: string, maximum: number): boolean {
  return value.length > 0 && withinBytes(value, maximum) && !EDGE_SPACE.test(value) && !CONTROL.test(value);
}

export function isMcpServersProvider(value: unknown): value is McpServersProvider {
  return value === 'claude' || value === 'codex';
}

export function isValidMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && boundedText(value, MCP_SERVERS_LIMITS.maxNameBytes) && !BIDI_CONTROL.test(value);
}

function isPort(value: string): boolean {
  return PORT.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
}
function isOptionalPort(suffix: string): boolean {
  return suffix === '' || (suffix.startsWith(':') && isPort(suffix.slice(1)));
}
function isBracketedAuthority(authority: string): boolean {
  const end = authority.indexOf(']');
  return end > 0 && IPV6_LITERAL.test(authority.slice(1, end)) && isOptionalPort(authority.slice(end + 1));
}
function isValidAuthority(authority: string): boolean {
  if (authority.startsWith('[')) return isBracketedAuthority(authority);
  const colon = authority.lastIndexOf(':');
  if (colon < 0) return HOST_NAME.test(authority);
  return HOST_NAME.test(authority.slice(0, colon)) && isPort(authority.slice(colon + 1));
}

export function isValidEndpointOrigin(value: string): boolean {
  if (!withinBytes(value, MCP_SERVERS_LIMITS.maxEndpointOriginBytes) || !MCP_ENDPOINT_ORIGIN_PATTERN.test(value)) return false;
  return isValidAuthority(value.slice(value.indexOf('://') + 3));
}

export function endpointOrigin(url: string): string | null {
  const match = HTTP_URL.exec(url);
  if (!match) return null;
  const scheme = match[1]!.length === 5 ? 'https' : 'http';
  const authority = match[2]!;
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/[A-Z]/g, letter => letter.toLowerCase());
  const origin = `${scheme}://${host}`;
  return isValidEndpointOrigin(origin) ? origin : null;
}

function utf8Length(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  if (point < 0x10000) return 3;
  return 4;
}
function utf8Prefix(value: string, maximum: number): string {
  let size = 0, end = 0;
  for (const character of value) {
    size += utf8Length(character);
    if (size > maximum) break;
    end += character.length;
  }
  return value.slice(0, end);
}
function boundedRawDetail(raw: string): string {
  const prefix = utf8Prefix(raw, MAX_RAW_DETAIL_BYTES);
  if (prefix.length === raw.length) return prefix;
  return prefix.split(WORD_SEPARATORS).slice(0, -1).join(' ');
}

function isSecretRun(run: string): boolean {
  return run.length >= MIN_OPAQUE_TOKEN_RUN || (run.length >= MIN_NUMBERED_TOKEN_RUN && /[0-9]/.test(run));
}
function isSensitiveText(text: string): boolean {
  return PATH_OR_ASSIGNMENT.test(text) || text.split(NON_TOKEN).some(isSecretRun);
}
function isOptionWord(word: string): boolean {
  const bare = word.replace(WRAPPING_PUNCTUATION, '');
  return OPTION.test(bare) && !NEGATIVE_NUMBER.test(bare);
}
function redactedWord(word: string): string {
  const separator = word.indexOf('://');
  if (separator < 0) return isSensitiveText(word) ? REDACTED : word;
  const start = separator - (SCHEME_TAIL.exec(word.slice(0, separator))?.[0].length ?? 0);
  const prefix = word.slice(0, start);
  if (isSensitiveText(prefix)) return REDACTED;
  return prefix + (endpointOrigin(word.slice(start)) ?? REDACTED);
}
function redactedWords(words: readonly string[]): readonly string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const word of words) {
    const option = isOptionWord(word);
    const replacement = redactNext || option ? REDACTED : redactedWord(word);
    redactNext = option;
    if (replacement === REDACTED && redacted.at(-1) === REDACTED) continue;
    redacted.push(replacement);
  }
  return redacted;
}

export function sanitizeMcpFailureDetail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const visible = boundedRawDetail(raw).replace(BIDI_CONTROLS, '').replace(LONE_SURROGATES, '�');
  const redacted = redactedWords(visible.split(WORD_SEPARATORS).filter(word => word.length > 0)).join(' ');
  return utf8Prefix(redacted, MCP_SERVERS_LIMITS.maxDetailBytes).replace(TRAILING_SPACE, '') || null;
}

function failureDetail(status: McpServerStatus, raw: unknown): string | null {
  if (status !== 'failed') return null;
  return sanitizeMcpFailureDetail(raw);
}
function remoteOrigin(transport: McpServerTransport, url: unknown): string | null {
  if (transport === 'stdio' || typeof url !== 'string') return null;
  return endpointOrigin(url);
}
function boundedToolCount(count: number): number | null {
  return count <= MCP_SERVERS_LIMITS.maxToolCount ? count : null;
}

function validEndpoint(row: Record<string, unknown>): boolean {
  if (row.endpointOrigin === null) return true;
  return typeof row.endpointOrigin === 'string' && row.transport !== 'stdio' && isValidEndpointOrigin(row.endpointOrigin);
}
function validToolCount(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MCP_SERVERS_LIMITS.maxToolCount;
}
function validDetail(row: Record<string, unknown>): boolean {
  if (row.detail === null) return true;
  return row.status === 'failed' && typeof row.detail === 'string' && boundedText(row.detail, MCP_SERVERS_LIMITS.maxDetailBytes);
}
function validServer(value: unknown): value is McpServer {
  const row = mcpRecord(value);
  return row !== null && exactKeys(row, SERVER_KEYS) && isValidMcpServerName(row.name) && member(MCP_SERVER_STATUSES, row.status) &&
    member(MCP_SERVER_SCOPES, row.scope) && member(MCP_SERVER_TRANSPORTS, row.transport) && validEndpoint(row) &&
    validToolCount(row.toolCount) && validDetail(row);
}

export function validateMcpServers(value: unknown): McpServers {
  const row = mcpRecord(value) ?? invalid();
  if (!exactKeys(row, ENVELOPE_KEYS) || row.version !== 1 || !isMcpServersProvider(row.provider) || typeof row.truncated !== 'boolean' ||
      !Array.isArray(row.servers) || row.servers.length > MCP_SERVERS_LIMITS.maxServers) invalid();
  const names = new Set<string>();
  for (const server of row.servers) {
    if (!validServer(server) || names.has(server.name)) invalid();
    names.add(server.name);
  }
  return row as unknown as McpServers;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const mismatch = left.findIndex((byte, index) => byte !== right[index]);
  if (mismatch < 0) return left.length - right.length;
  return left[mismatch]! - (right[mismatch] ?? -1);
}
function byNameBytes(left: McpServer, right: McpServer): number {
  return compareBytes(encoder.encode(left.name), encoder.encode(right.name));
}
function assemble(provider: McpServersProvider, entries: readonly unknown[], map: (entry: unknown) => McpServer | null, incomplete: boolean): McpServers {
  const names = new Set<string>();
  const servers: McpServer[] = [];
  let truncated = incomplete;
  for (const entry of entries) {
    const server = map(entry);
    if (!server || !isValidMcpServerName(server.name) || names.has(server.name)) { truncated = true; continue; }
    if (servers.length === MCP_SERVERS_LIMITS.maxServers) { truncated = true; break; }
    names.add(server.name);
    servers.push(server);
  }
  return validateMcpServers({ version: 1, provider, truncated, servers: servers.sort(byNameBytes) });
}

function claudeTransport(config: Record<string, unknown> | null): McpServerTransport {
  if (!present(config?.type)) return 'stdio';
  return mapped(CLAUDE_TRANSPORTS, config?.type, 'unknown');
}
function claudeServer(value: unknown): McpServer | null {
  const entry = mcpRecord(value);
  if (!entry || typeof entry.name !== 'string') return null;
  const config = mcpRecord(entry.config);
  const status = mapped(CLAUDE_STATUSES, entry.status, 'unknown');
  const transport = claudeTransport(config);
  return { name: entry.name, status, scope: mapped(CLAUDE_SCOPES, entry.scope, 'unknown'), transport,
    endpointOrigin: remoteOrigin(transport, config?.url),
    toolCount: Array.isArray(entry.tools) ? boundedToolCount(entry.tools.length) : null,
    detail: failureDetail(status, entry.error) };
}

export function parseClaudeMcpServers(response: unknown): McpServers {
  const servers = mcpRecord(response)?.mcpServers;
  if (!Array.isArray(servers)) invalid();
  return assemble('claude', servers, claudeServer, false);
}

function codexStatus(entry: Record<string, unknown>): McpServerStatus {
  if (present(entry.runtimeStatus)) return mapped(CODEX_RUNTIME_STATUSES, entry.runtimeStatus, 'unknown');
  if (entry.authStatus === 'notLoggedIn') return 'needsAuth';
  if (typeof entry.toolsError === 'string' && VISIBLE.test(entry.toolsError)) return 'failed';
  if (present(entry.serverInfo)) return 'connected';
  return 'unknown';
}
function codexServer(value: unknown): McpServer | null {
  const entry = mcpRecord(value);
  if (!entry || typeof entry.name !== 'string') return null;
  const status = codexStatus(entry);
  const transport: McpServerTransport = present(entry.httpOrigin) ? 'http' : 'stdio';
  const tools = mcpRecord(entry.tools);
  return { name: entry.name, status, scope: present(entry.pluginId) ? 'plugin' : 'unknown', transport,
    endpointOrigin: remoteOrigin(transport, entry.httpOrigin),
    toolCount: tools ? boundedToolCount(Object.keys(tools).length) : null,
    detail: failureDetail(status, entry.toolsError) };
}

export function parseCodexMcpServers(result: unknown): McpServers {
  const row = mcpRecord(result);
  const data = row?.data;
  if (!row || !Array.isArray(data)) invalid();
  return assemble('codex', data, codexServer, present(row.nextCursor));
}

function hasLiveStatus(server: McpServer): boolean {
  return server.status === 'connected' || server.status === 'connecting';
}
function isDisabledInCodexConfig(configured: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(configured, name) && mcpRecord(configured[name])?.enabled === false;
}
function withCodexConfiguredState(server: McpServer, configured: Record<string, unknown>): McpServer {
  if (hasLiveStatus(server) || !isDisabledInCodexConfig(configured, server.name)) return server;
  return { ...server, status: 'disabled', detail: null };
}

export function markCodexDisabledMcpServers(snapshot: McpServers, config: unknown): McpServers {
  const configured = mcpRecord(mcpRecord(mcpRecord(config)?.config)?.mcp_servers);
  if (!configured) return snapshot;
  return { ...snapshot, servers: snapshot.servers.map(server => withCodexConfiguredState(server, configured)) };
}
