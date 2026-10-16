import { createHash } from 'node:crypto';
import { RunnerError } from './contracts.js';
import { isConfigurableMcpServerName, isValidMcpArgs, isValidMcpCommand, isValidMcpLaunchUrl } from './mcp-server-management.js';
import { mcpRecord } from './mcp-servers.js';

export const MCP_DEVICE_SYNC_CAPABILITY = 'mcpDeviceSync';
export const MCP_DEVICE_SYNC_OUTCOMES = ['added', 'updated', 'unchanged', 'removed', 'keptServerEntry', 'commandMissing', 'failed'] as const;
export const MCP_DEVICE_SYNC_LIMITS = Object.freeze({
  bodyBytes: 256 * 1024, servers: 32, retain: 64, envEntries: 64, envValueBytes: 8192, headers: 32, headerValueBytes: 8192,
  results: 96, cliRuns: 32, ledgerEntries: 96, ledgerBytes: 64 * 1024, addJsonBytes: 32_768,
});

export type McpDeviceSyncOutcome = typeof MCP_DEVICE_SYNC_OUTCOMES[number];
export type McpDevicePairs = readonly (readonly [string, string])[];
export type McpDeviceLaunch =
  | Readonly<{ kind: 'stdio'; command: string; args: readonly string[]; env: McpDevicePairs }>
  | Readonly<{ kind: 'http' | 'sse'; url: string; headers: McpDevicePairs }>;
export type McpDeviceServer = Readonly<{ name: string; launch: McpDeviceLaunch }>;
export type McpDeviceSyncRequest = Readonly<{ servers: readonly McpDeviceServer[]; retain: readonly string[] }>;
export type McpDeviceSyncResult = Readonly<{ name: string; outcome: McpDeviceSyncOutcome }>;
export type McpDeviceSyncReport = Readonly<{ version: 1; results: readonly McpDeviceSyncResult[] }>;
export type ClaudeStoredServer = Readonly<{ kind: 'recognized'; launch: McpDeviceLaunch }> | Readonly<{ kind: 'unrecognized' }>;
export type ClaudeStoredServers = ReadonlyMap<string, ClaudeStoredServer>;
export type McpDeviceSyncLedger = Readonly<{ kind: 'valid'; servers: ReadonlyMap<string, string> }> | Readonly<{ kind: 'corrupt' }>;
export type McpDeviceSyncStep = Readonly<{ kind: 'add'; name: string; json: string }> | Readonly<{ kind: 'remove'; name: string; digest: string }>;
export type McpDeviceSyncProgress = 'applied' | 'diverged';
export type McpDeviceSyncItem = Readonly<{
  name: string; outcome: McpDeviceSyncOutcome | null; steps: readonly McpDeviceSyncStep[];
  expected: string | null; ledger: string | null; fallback: string | null;
}>;
export type McpDeviceSyncPlan = Readonly<{ items: readonly McpDeviceSyncItem[] }>;
export type McpDeviceSyncSettlement = Readonly<{ report: McpDeviceSyncReport; ledger: ReadonlyMap<string, string> }>;

const REQUEST_KEYS = ['version', 'servers', 'retain'] as const;
const SERVER_KEYS = ['name', 'launch'] as const;
const STDIO_KEYS = ['kind', 'command', 'args', 'env'] as const;
const REMOTE_KEYS = ['kind', 'url', 'headers'] as const;
const LEDGER_KEYS = ['version', 'servers'] as const;
const LEDGER_ENTRY_KEYS = ['name', 'digest'] as const;
const STORED_STDIO_KEYS: ReadonlySet<string> = new Set(['type', 'command', 'args', 'env']);
const STORED_REMOTE_KEYS: ReadonlySet<string> = new Set(['type', 'url', 'headers']);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const NUL = /\u0000/;
const HEADER_FORBIDDEN = /[\r\n\u0000]/;
const DIGEST = /^[0-9a-f]{64}$/;
const UNRECOGNIZED: ClaudeStoredServer = Object.freeze({ kind: 'unrecognized' });
const NO_NAMES: ReadonlySet<string> = new Set();
const encoder = new TextEncoder();

export const EMPTY_MCP_DEVICE_SYNC_LEDGER: McpDeviceSyncLedger = Object.freeze({ kind: 'valid', servers: new Map<string, string>() });

function invalid(): never { throw new RunnerError('invalid_input'); }
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}
function onlyKeys(row: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(row).every(key => keys.has(key));
}
function withinBytes(value: string, maximum: number): boolean {
  return value.length <= maximum && encoder.encode(value).length <= maximum;
}
function byKey(left: readonly [string, string], right: readonly [string, string]): number {
  if (left[0] < right[0]) return -1;
  if (left[0] > right[0]) return 1;
  return 0;
}
function byName(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pairs(value: unknown, maximum: number, validKey: (key: string) => boolean, validValue: (value: string) => boolean): McpDevicePairs {
  const row = mcpRecord(value) ?? invalid();
  const keys = Object.keys(row);
  if (keys.length > maximum) invalid();
  return keys.map(key => {
    const entry = row[key];
    if (!validKey(key) || typeof entry !== 'string' || !validValue(entry)) invalid();
    return [key, entry] as const;
  }).sort(byKey);
}
function validEnvValue(value: string): boolean {
  return withinBytes(value, MCP_DEVICE_SYNC_LIMITS.envValueBytes) && !NUL.test(value);
}
function validHeaderValue(value: string): boolean {
  return withinBytes(value, MCP_DEVICE_SYNC_LIMITS.headerValueBytes) && !HEADER_FORBIDDEN.test(value);
}
function headers(value: unknown): McpDevicePairs {
  const parsed = pairs(value, MCP_DEVICE_SYNC_LIMITS.headers, key => HEADER_NAME.test(key), validHeaderValue);
  if (new Set(parsed.map(([name]) => name.toLowerCase())).size !== parsed.length) invalid();
  return parsed;
}

function launch(value: unknown): McpDeviceLaunch {
  const row = mcpRecord(value) ?? invalid();
  switch (row.kind) {
    case 'stdio':
      if (!exactKeys(row, STDIO_KEYS) || !isValidMcpCommand(row.command) || !isValidMcpArgs(row.args)) invalid();
      return { kind: 'stdio', command: row.command, args: [...row.args],
        env: pairs(row.env, MCP_DEVICE_SYNC_LIMITS.envEntries, key => ENV_KEY.test(key), validEnvValue) };
    case 'http': case 'sse':
      if (!exactKeys(row, REMOTE_KEYS) || !isValidMcpLaunchUrl(row.url)) invalid();
      return { kind: row.kind, url: row.url, headers: headers(row.headers) };
    default: return invalid();
  }
}
function server(value: unknown): McpDeviceServer {
  const row = mcpRecord(value) ?? invalid();
  if (!exactKeys(row, SERVER_KEYS) || !isConfigurableMcpServerName(row.name)) invalid();
  return { name: row.name, launch: launch(row.launch) };
}
function names(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MCP_DEVICE_SYNC_LIMITS.retain || !value.every(isConfigurableMcpServerName)) invalid();
  return [...value];
}

export function parseMcpDeviceSyncRequest(input: unknown): McpDeviceSyncRequest {
  const row = mcpRecord(input) ?? invalid();
  if (!exactKeys(row, REQUEST_KEYS) || row.version !== 1) invalid();
  if (!Array.isArray(row.servers) || row.servers.length > MCP_DEVICE_SYNC_LIMITS.servers) invalid();
  const servers = row.servers.map(server);
  const retain = names(row.retain);
  const all = [...servers.map(entry => entry.name), ...retain];
  if (new Set(all).size !== all.length) invalid();
  return { servers, retain };
}

function storedStrings(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) return null;
  return [...value];
}
function storedPairs(value: unknown): McpDevicePairs | null {
  if (value === undefined) return [];
  const row = mcpRecord(value);
  if (!row) return null;
  const entries = Object.entries(row);
  if (!entries.every(([, entry]) => typeof entry === 'string')) return null;
  return entries.map(([key, entry]) => [key, entry as string] as const).sort(byKey);
}
function storedStdio(row: Record<string, unknown>): ClaudeStoredServer {
  const args = storedStrings(row.args), env = storedPairs(row.env);
  if (!onlyKeys(row, STORED_STDIO_KEYS) || typeof row.command !== 'string' || args === null || env === null) return UNRECOGNIZED;
  return { kind: 'recognized', launch: { kind: 'stdio', command: row.command, args, env } };
}
function storedRemote(kind: 'http' | 'sse', row: Record<string, unknown>): ClaudeStoredServer {
  const parsed = storedPairs(row.headers);
  if (!onlyKeys(row, STORED_REMOTE_KEYS) || typeof row.url !== 'string' || parsed === null) return UNRECOGNIZED;
  return { kind: 'recognized', launch: { kind, url: row.url, headers: parsed } };
}

export function parseClaudeStoredServer(value: unknown): ClaudeStoredServer {
  const row = mcpRecord(value);
  if (!row) return UNRECOGNIZED;
  switch (row.type ?? 'stdio') {
    case 'stdio': return storedStdio(row);
    case 'http': return storedRemote('http', row);
    case 'sse': return storedRemote('sse', row);
    default: return UNRECOGNIZED;
  }
}

export function claudeLocalServers(config: unknown, key: string, wanted: Iterable<string>): ClaudeStoredServers {
  const root = mcpRecord(config);
  if (!root) throw new RunnerError('storage_unavailable');
  const projects = mcpRecord(root.projects);
  const project = projects && Object.hasOwn(projects, key) ? mcpRecord(projects[key]) : null;
  const servers = mcpRecord(project?.mcpServers);
  const found = new Map<string, ClaudeStoredServer>();
  if (!servers) return found;
  for (const name of wanted) if (Object.hasOwn(servers, name)) found.set(name, parseClaudeStoredServer(servers[name]));
  return found;
}

function canonical(launch: McpDeviceLaunch): unknown {
  switch (launch.kind) {
    case 'stdio': return ['stdio', launch.command, launch.args, launch.env];
    case 'http': case 'sse': return [launch.kind, launch.url, launch.headers];
  }
}

export function mcpDeviceLaunchDigest(launch: McpDeviceLaunch): string {
  return createHash('sha256').update(JSON.stringify(canonical(launch))).digest('hex');
}

export function claudeMcpJson(launch: McpDeviceLaunch): string {
  switch (launch.kind) {
    case 'stdio': return JSON.stringify({ type: 'stdio', command: launch.command, args: launch.args, env: Object.fromEntries(launch.env) });
    case 'http': case 'sse': return JSON.stringify({ type: launch.kind, url: launch.url, headers: Object.fromEntries(launch.headers) });
  }
}

export function isLaunchableMcpDeviceLaunch(launch: McpDeviceLaunch): boolean {
  return encoder.encode(claudeMcpJson(launch)).length <= MCP_DEVICE_SYNC_LIMITS.addJsonBytes;
}

export function storedDigest(entry: ClaudeStoredServer | undefined): string | null {
  return entry?.kind === 'recognized' ? mcpDeviceLaunchDigest(entry.launch) : null;
}

export function parseMcpDeviceSyncLedger(value: unknown): McpDeviceSyncLedger {
  const row = mcpRecord(value);
  if (!row || !exactKeys(row, LEDGER_KEYS) || row.version !== 1 || !Array.isArray(row.servers) ||
    row.servers.length > MCP_DEVICE_SYNC_LIMITS.ledgerEntries) return { kind: 'corrupt' };
  const servers = new Map<string, string>();
  for (const value of row.servers) {
    const entry = mcpRecord(value);
    if (!entry || !exactKeys(entry, LEDGER_ENTRY_KEYS) || !isConfigurableMcpServerName(entry.name) || typeof entry.digest !== 'string' ||
      !DIGEST.test(entry.digest) || servers.has(entry.name)) return { kind: 'corrupt' };
    servers.set(entry.name, entry.digest);
  }
  return { kind: 'valid', servers };
}

export function serializeMcpDeviceSyncLedger(servers: ReadonlyMap<string, string>): string {
  if (servers.size > MCP_DEVICE_SYNC_LIMITS.ledgerEntries) throw new RunnerError('storage_unavailable');
  const entries = [...servers].sort(byKey).map(([name, digest]) => ({ name, digest }));
  return JSON.stringify({ version: 1, servers: entries });
}

export function sameMcpDeviceSyncLedger(ledger: McpDeviceSyncLedger, servers: ReadonlyMap<string, string>): boolean {
  if (ledger.kind !== 'valid' || ledger.servers.size !== servers.size) return false;
  return [...servers].every(([name, digest]) => ledger.servers.get(name) === digest);
}

export function mcpDeviceSyncNames(request: McpDeviceSyncRequest, ledger: McpDeviceSyncLedger): ReadonlySet<string> {
  return new Set([...request.servers.map(entry => entry.name), ...request.retain, ...(ledger.kind === 'valid' ? ledger.servers.keys() : [])]);
}

type Budget = { runs: number; results: number; slots: number };

function item(name: string, outcome: McpDeviceSyncOutcome | null, ledger: string | null): McpDeviceSyncItem {
  return { name, outcome, steps: [], expected: null, ledger, fallback: null };
}
function charged(budget: Budget, steps: readonly McpDeviceSyncStep[], slots = 0): boolean {
  if (steps.length > budget.runs || slots > budget.slots) return false;
  budget.runs -= steps.length;
  budget.slots -= slots;
  return true;
}
function claimed(budget: Budget): boolean {
  return charged(budget, [], 1);
}
function matching(name: string, digest: string, current: ClaudeStoredServers): boolean {
  return storedDigest(current.get(name)) === digest;
}

function desiredItem(entry: McpDeviceServer, current: ClaudeStoredServers, owned: string | null, missing: boolean, budget: Budget): McpDeviceSyncItem {
  const want = mcpDeviceLaunchDigest(entry.launch);
  const stored = current.get(entry.name);
  const have = storedDigest(stored);
  const managedNow = stored !== undefined && owned !== null && have === owned;
  if (stored && have === want) return item(entry.name, 'unchanged', managedNow || claimed(budget) ? want : null);
  if (stored && !managedNow) return item(entry.name, 'keptServerEntry', null);
  const fallback = stored ? owned : null;
  if (missing) return item(entry.name, 'commandMissing', fallback);
  if (!isLaunchableMcpDeviceLaunch(entry.launch)) return item(entry.name, 'failed', fallback);
  const add: McpDeviceSyncStep = { kind: 'add', name: entry.name, json: claudeMcpJson(entry.launch) };
  const steps: readonly McpDeviceSyncStep[] = stored && owned !== null ? [{ kind: 'remove', name: entry.name, digest: owned }, add] : [add];
  if (!charged(budget, steps, stored ? 0 : 1)) return item(entry.name, 'failed', fallback);
  return { name: entry.name, outcome: stored ? 'updated' : 'added', steps, expected: want, ledger: want, fallback };
}

function staleItem(name: string, owned: string, current: ClaudeStoredServers, budget: Budget): McpDeviceSyncItem {
  const stored = current.get(name);
  if (!stored) return item(name, null, null);
  if (budget.results < 1) return item(name, null, matching(name, owned, current) ? owned : null);
  budget.results -= 1;
  if (storedDigest(stored) !== owned) return item(name, 'keptServerEntry', null);
  const steps: readonly McpDeviceSyncStep[] = [{ kind: 'remove', name, digest: owned }];
  if (!charged(budget, steps)) return item(name, 'failed', owned);
  return { name, outcome: 'removed', steps, expected: null, ledger: null, fallback: owned };
}

export function planDeviceSync(desired: readonly McpDeviceServer[], retain: readonly string[], current: ClaudeStoredServers,
  ledger: McpDeviceSyncLedger, missingCommands: ReadonlySet<string> = NO_NAMES): McpDeviceSyncPlan {
  const managed: ReadonlyMap<string, string> = ledger.kind === 'valid' ? ledger.servers : new Map();
  const kept = [...managed].filter(([name, digest]) => matching(name, digest, current)).length;
  const budget: Budget = { runs: MCP_DEVICE_SYNC_LIMITS.cliRuns, results: MCP_DEVICE_SYNC_LIMITS.results - desired.length,
    slots: MCP_DEVICE_SYNC_LIMITS.ledgerEntries - kept };
  const wanted = new Set(desired.map(entry => entry.name));
  const retained = new Set(retain);
  const items = desired.map(entry => desiredItem(entry, current, managed.get(entry.name) ?? null, missingCommands.has(entry.name), budget));
  for (const name of [...managed.keys()].sort(byName)) {
    if (wanted.has(name)) continue;
    const owned = managed.get(name)!;
    items.push(retained.has(name) ? item(name, null, matching(name, owned, current) ? owned : null) : staleItem(name, owned, current, budget));
  }
  return { items };
}

function verified(entry: McpDeviceSyncItem, progress: McpDeviceSyncProgress | undefined, now: ClaudeStoredServer | undefined): boolean {
  if (progress !== 'applied') return false;
  if (entry.expected === null) return now === undefined;
  return storedDigest(now) === entry.expected;
}
function settledOutcome(entry: McpDeviceSyncItem, progress: McpDeviceSyncProgress | undefined, succeeded: boolean): McpDeviceSyncOutcome | null {
  if (entry.outcome === null) return null;
  if (progress === 'diverged') return 'keptServerEntry';
  return succeeded ? entry.outcome : 'failed';
}

export function settleDeviceSync(plan: McpDeviceSyncPlan, progress: ReadonlyMap<string, McpDeviceSyncProgress>, final: ClaudeStoredServers): McpDeviceSyncSettlement {
  const results: McpDeviceSyncResult[] = [];
  const ledger = new Map<string, string>();
  for (const entry of plan.items) {
    const now = final.get(entry.name);
    const state = progress.get(entry.name);
    const succeeded = entry.steps.length === 0 || verified(entry, state, now);
    const candidate = state === 'diverged' ? null : succeeded ? entry.ledger : entry.fallback;
    if (candidate !== null && storedDigest(now) === candidate) ledger.set(entry.name, candidate);
    const outcome = settledOutcome(entry, state, succeeded);
    if (outcome !== null) results.push({ name: entry.name, outcome });
  }
  return { report: { version: 1, results }, ledger };
}

export function preapprovedMcpServers(ledger: McpDeviceSyncLedger, current: ClaudeStoredServers): readonly string[] {
  if (ledger.kind !== 'valid') return [];
  return [...ledger.servers].filter(([name, digest]) => storedDigest(current.get(name)) === digest).map(([name]) => name).sort(byName);
}
