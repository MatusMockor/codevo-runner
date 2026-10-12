import { RunnerError, type ErrorCode } from './contracts.js';
import { isValidMcpServerName, mcpRecord, type McpServersProvider } from './mcp-servers.js';

export const MCP_SERVER_MANAGEMENT_CAPABILITY = 'mcpServerManagement';
export const MCP_SERVER_CONFIG_SCOPES = ['user', 'project', 'local'] as const;
export const MCP_SERVER_LOGIN_MODES = ['signIn', 'signInAgain'] as const;
export const MCP_SERVER_LOGIN_STATES = ['pending', 'succeeded', 'failed'] as const;
export const MCP_SERVER_MANAGEMENT_ERRORS = ['mcp_server_exists', 'mcp_server_not_found', 'mcp_change_unsupported', 'mcp_login_unsupported',
  'mcp_login_inactive', 'mcp_callback_rejected'] as const satisfies readonly ErrorCode[];
export type McpServerConfigScope = typeof MCP_SERVER_CONFIG_SCOPES[number];
export type McpServerLaunch =
  | Readonly<{ kind: 'http'; url: string }>
  | Readonly<{ kind: 'sse'; url: string }>
  | Readonly<{ kind: 'stdio'; command: string; args: readonly string[] }>;
export type McpServerAdd = Readonly<{ kind: 'add'; name: string; scope: McpServerConfigScope; launch: McpServerLaunch }>;
export type McpServerRemove = Readonly<{ kind: 'remove'; name: string; scope: McpServerConfigScope }>;
export type McpServerSignOut = Readonly<{ kind: 'signOut'; name: string }>;
export type McpServerChange = McpServerAdd | McpServerRemove | McpServerSignOut;
export type McpServerLoginMode = typeof MCP_SERVER_LOGIN_MODES[number];
export type McpServerLoginRequest = Readonly<{ name: string; mode: McpServerLoginMode }>;
export type McpServerLoginDelivery = 'automatic' | 'paste';
export type McpServerLoginStep =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'finishInBrowser'; authorizationUrl: string }>
  | Readonly<{ kind: 'awaitingCallback'; loginId: string; authorizationUrl: string; delivery: McpServerLoginDelivery }>;
export type McpServerLoginState = typeof MCP_SERVER_LOGIN_STATES[number];
export type McpServerChanged = Readonly<{ version: 1 }>;
export type McpServerLoginStarted = Readonly<{ version: 1; step: McpServerLoginStep }>;
export type McpServerLoginStatus = Readonly<{ version: 1; state: McpServerLoginState }>;
export type McpLoopbackRedirect = Readonly<{ port: number; path: string }>;

export const MCP_SERVER_MANAGEMENT_LIMITS = Object.freeze({
  maxUrlBytes: 2048, maxCommandBytes: 1024, maxArgs: 32, maxArgBytes: 1024, maxAuthorizationUrlBytes: 4096, maxCallbackUrlBytes: 8192,
});
export const MCP_CONFIGURABLE_SERVER_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const MCP_SERVER_LOGIN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const CHANGE_REQUEST_KEYS = ['change'] as const;
const ADD_KEYS = ['kind', 'name', 'scope', 'launch'] as const;
const REMOVE_KEYS = ['kind', 'name', 'scope'] as const;
const SIGN_OUT_KEYS = ['kind', 'name'] as const;
const REMOTE_LAUNCH_KEYS = ['kind', 'url'] as const;
const STDIO_LAUNCH_KEYS = ['kind', 'command', 'args'] as const;
const LOGIN_REQUEST_KEYS = ['name', 'mode'] as const;
const CALLBACK_REQUEST_KEYS = ['callbackUrl'] as const;
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];
const CONTROL = /[\p{Cc}\p{Cs}]/u;
const SPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}\p{Cs}]/u;
const HTTP_PREFIX = /^https?:\/\//i;
const AUTHORIZATION_PREFIX = /^https?:\/\//;
const DEFAULT_HTTP_PORT = 80;
const encoder = new TextEncoder();

function invalid(): never { throw new RunnerError('invalid_input'); }
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}
function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some(candidate => candidate === value);
}
function withinBytes(value: string, maximum: number): boolean {
  return value.length <= maximum && encoder.encode(value).length <= maximum;
}
function parsedUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}
function httpUrl(value: unknown, maximum: number): URL | null {
  if (typeof value !== 'string' || !withinBytes(value, maximum) || SPACE_OR_CONTROL.test(value) || !HTTP_PREFIX.test(value)) return null;
  return parsedUrl(value);
}
function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
}
function port(url: URL): number {
  return url.port === '' ? DEFAULT_HTTP_PORT : Number(url.port);
}

export function isConfigurableMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && MCP_CONFIGURABLE_SERVER_NAME_PATTERN.test(value);
}
export function isValidMcpLaunchUrl(value: unknown): value is string {
  const url = httpUrl(value, MCP_SERVER_MANAGEMENT_LIMITS.maxUrlBytes);
  return url !== null && url.username === '' && url.password === '';
}
export function isValidMcpCommand(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && withinBytes(value, MCP_SERVER_MANAGEMENT_LIMITS.maxCommandBytes) && !CONTROL.test(value);
}
function isValidMcpArg(value: unknown): value is string {
  return typeof value === 'string' && withinBytes(value, MCP_SERVER_MANAGEMENT_LIMITS.maxArgBytes) && !CONTROL.test(value);
}
export function isValidMcpArgs(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MCP_SERVER_MANAGEMENT_LIMITS.maxArgs && value.every(isValidMcpArg);
}
export function isValidMcpAuthorizationUrl(value: unknown): value is string {
  const url = httpUrl(value, MCP_SERVER_MANAGEMENT_LIMITS.maxAuthorizationUrlBytes);
  if (url === null || !AUTHORIZATION_PREFIX.test(String(value))) return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.protocol === 'https:' || isLoopbackHttp(url);
}
export function isMcpServerLoginId(value: unknown): value is string {
  return typeof value === 'string' && MCP_SERVER_LOGIN_ID_PATTERN.test(value);
}
export function isValidMcpCallbackUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !withinBytes(value, MCP_SERVER_MANAGEMENT_LIMITS.maxCallbackUrlBytes)) return false;
  const url = parsedUrl(value);
  return url !== null && isLoopbackHttp(url) && (url.searchParams.has('code') || url.searchParams.has('error'));
}
export function isMcpServerManagementError(code: ErrorCode): boolean {
  return MCP_SERVER_MANAGEMENT_ERRORS.some(candidate => candidate === code);
}

function launch(value: unknown): McpServerLaunch {
  const row = mcpRecord(value) ?? invalid();
  switch (row.kind) {
    case 'http': case 'sse':
      if (!exactKeys(row, REMOTE_LAUNCH_KEYS) || !isValidMcpLaunchUrl(row.url)) invalid();
      return { kind: row.kind, url: row.url };
    case 'stdio':
      if (!exactKeys(row, STDIO_LAUNCH_KEYS) || !isValidMcpCommand(row.command) || !isValidMcpArgs(row.args)) invalid();
      return { kind: 'stdio', command: row.command, args: [...row.args] };
    default: return invalid();
  }
}
function change(value: unknown): McpServerChange {
  const row = mcpRecord(value) ?? invalid();
  switch (row.kind) {
    case 'add':
      if (!exactKeys(row, ADD_KEYS) || !isConfigurableMcpServerName(row.name) || !member(MCP_SERVER_CONFIG_SCOPES, row.scope)) invalid();
      return { kind: 'add', name: row.name, scope: row.scope, launch: launch(row.launch) };
    case 'remove':
      if (!exactKeys(row, REMOVE_KEYS) || !isConfigurableMcpServerName(row.name) || !member(MCP_SERVER_CONFIG_SCOPES, row.scope)) invalid();
      return { kind: 'remove', name: row.name, scope: row.scope };
    case 'signOut':
      if (!exactKeys(row, SIGN_OUT_KEYS) || !isValidMcpServerName(row.name)) invalid();
      return { kind: 'signOut', name: row.name };
    default: return invalid();
  }
}

export function parseMcpServerChangeRequest(input: unknown): McpServerChange {
  const row = mcpRecord(input) ?? invalid();
  if (!exactKeys(row, CHANGE_REQUEST_KEYS)) invalid();
  return change(row.change);
}

export function parseMcpServerLoginRequest(input: unknown): McpServerLoginRequest {
  const row = mcpRecord(input) ?? invalid();
  if (!exactKeys(row, LOGIN_REQUEST_KEYS) || !isValidMcpServerName(row.name) || !member(MCP_SERVER_LOGIN_MODES, row.mode)) invalid();
  return { name: row.name, mode: row.mode };
}

export function parseMcpServerLoginCallback(input: unknown): string {
  const row = mcpRecord(input) ?? invalid();
  if (!exactKeys(row, CALLBACK_REQUEST_KEYS) || !isValidMcpCallbackUrl(row.callbackUrl)) invalid();
  return row.callbackUrl;
}

function claudeChangeSupported(change: McpServerChange): boolean {
  return change.kind !== 'add' || change.scope !== 'project';
}
function codexChangeSupported(change: McpServerChange): boolean {
  switch (change.kind) {
    case 'signOut': return true;
    case 'remove': return change.scope === 'user';
    case 'add': return change.scope === 'user' && change.launch.kind !== 'sse';
  }
}

export function isMcpServerChangeSupported(provider: McpServersProvider, change: McpServerChange): boolean {
  switch (provider) {
    case 'claude': return claudeChangeSupported(change);
    case 'codex': return codexChangeSupported(change);
  }
}

export function mcpLoopbackRedirect(authorizationUrl: string): McpLoopbackRedirect | null {
  const redirect = parsedUrl(parsedUrl(authorizationUrl)?.searchParams.get('redirect_uri') ?? '');
  if (!redirect || !isLoopbackHttp(redirect) || redirect.username !== '' || redirect.password !== '') return null;
  return { port: port(redirect), path: redirect.pathname };
}

export function mcpLoopbackCallbackPath(redirect: McpLoopbackRedirect, callbackUrl: string): string | null {
  const callback = parsedUrl(callbackUrl);
  if (!callback || !isLoopbackHttp(callback) || port(callback) !== redirect.port || callback.pathname !== redirect.path) return null;
  return redirect.path + callback.search;
}
