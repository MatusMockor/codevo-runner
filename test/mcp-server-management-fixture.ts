import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { lines, shellFixture } from './mcp-servers-fixture.js';

export const SECRET = 'SECRET_MARKER';
export const CLAUDE_AUTH_URL = `https://auth.example.com/authorize?client_id=${SECRET}&state=${SECRET}&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback`;
export const CLAUDE_CALLBACK_URL = `http://localhost:45678/callback?code=${SECRET}&state=${SECRET}`;
export const claudeAwaiting = { authUrl: CLAUDE_AUTH_URL, requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', state: SECRET, callbackPort: 45678 };
export const claudeBrowser = { authUrl: `https://claude.ai/connectors/${SECRET}`, requiresUserAction: true, callbackExpected: false };
export const claudeNothing = { requiresUserAction: false, callbackExpected: false };
export const claudeStatus = (name: string, status: string) => ({ mcpServers: [{ name: 'other', status: 'connected' }, { name, status, config: { type: 'http', url: `https://mcp.example.com/${SECRET}` } }] });
export const codexAuthUrl = (port: number, path = '/callback') =>
  `https://auth.example.com/authorize?client_id=${SECRET}&state=${SECRET}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}${path}`)}`;
export const codexLoginResult = (port: number, loginId: string | null = 'codex-login-1') => ({ result: { authorizationUrl: codexAuthUrl(port), loginId } });
export const codexCompleted = (name: string, success: boolean, loginId: string | null = 'codex-login-1') =>
  ({ method: 'mcpServer/oauthLogin/completed', params: { name, threadId: null, loginId, success, error: success ? null : `denied ${SECRET}` } });

const preamble = (root: string) => `#!/bin/sh
root='${root}'
echo $$ > "$root/pid"
echo launch >> "$root/launches"
launch=$(wc -l < "$root/launches" | tr -d ' ')
for arg in "$@"; do printf '%s\\n' "$arg" >> "$root/args-$launch"; done
env > "$root/env"
pwd > "$root/cwd"
sleep 600 &
echo $! > "$root/descendant-pid"
[ -f "$root/hang" ] && sleep 600
if [ "$1" = mcp ] && [ -f "$root/cli-fail" ]; then cat "$root/cli-fail" >&2; exit 1; fi
`;
const answer = (reply: string) => `printf '{"type":"control_response","response":{"request_id":"%s",' "$id"; ${reply}; printf '}}\\n'`;
const controlled = (name: string) => `if [ -f "$root/${name}-error" ]; then
        ${answer(`printf '"subtype":"error","error":"%s"' "$(cat "$root/${name}-error")"`)}
      else
        ${answer(`printf '"subtype":"success","response":'; if [ -f "$root/${name}.json" ]; then cat "$root/${name}.json"; else printf '{}'; fi`)}
      fi`;

export function claudeManagementScript(root: string): string {
  return `${preamble(root)}if [ "$1" = mcp ] && [ "$2" = add ]; then
  if [ -e "$root/configured/$8" ]; then echo "MCP server $8 already exists in $4 config" >&2; exit 1; fi
  : > "$root/configured/$8"
  echo "Added $6 MCP server $8 to $4 config"
  exit 0
fi
if [ "$1" = mcp ] && [ "$2" = remove ]; then
  if [ ! -e "$root/configured/$6" ]; then echo "No MCP server named \\"$6\\" in $4 scope" >&2; exit 1; fi
  rm "$root/configured/$6"
  echo "Removed MCP server $6 from $4 config"
  exit 0
fi
[ "$1" = mcp ] && exit 2
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$root/stdin"
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"subtype":"initialize"'*)
      ${controlled('initialize')} ;;
    *'"subtype":"mcp_clear_auth"'*)
      ${controlled('clear-auth')} ;;
    *'"subtype":"mcp_authenticate"'*)
      ${controlled('authenticate')} ;;
    *'"subtype":"mcp_oauth_callback_url"'*)
      if [ ! -f "$root/callback-silent" ]; then
      ${controlled('callback')}
      fi ;;
    *'"subtype":"mcp_status"'*)
      ${controlled('status')} ;;
  esac
done
`;
}

export function codexManagementScript(root: string): string {
  return `${preamble(root)}if [ "$1" = mcp ] && [ "$2" = remove ]; then
  if [ ! -e "$root/configured/$4" ]; then echo "No MCP server named '$4' found."; exit 0; fi
  rm "$root/configured/$4"
  echo "Removed global MCP server '$4'."
  exit 0
fi
if [ "$1" = mcp ] && [ "$2" = logout ]; then
  [ -f "$root/logout-output" ] && cat "$root/logout-output" >&2
  [ -f "$root/logout-exit" ] && exit "$(cat "$root/logout-exit")"
  echo "Removed OAuth credentials for '$4'."
  exit 0
fi
[ "$1" = mcp ] && exit 2
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$root/stdin"
  case "$line" in
    *'"method":"initialized"'*) ;;
    *'"method":"initialize"'*)
      printf '%s\\n' '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}'
      if [ -f "$root/initialize-error" ]; then printf '%s\\n' '{"id":0,"error":{"code":-32600,"message":"refused"}}'; else printf '%s\\n' '{"id":0,"result":{"userAgent":"synthetic"}}'; fi ;;
    *'"method":"config/read"'*)
      printf '{"id":1,'; tail -c +2 "$root/config.json"; printf '\\n' ;;
    *'"method":"config/batchWrite"'*)
      printf '{"id":2,'; tail -c +2 "$root/write.json"; printf '\\n' ;;
    *'"method":"mcpServer/oauth/login"'*)
      printf '{"id":1,'; tail -c +2 "$root/login.json"; printf '\\n'
      ( while [ ! -f "$root/completed.json" ]; do sleep 0.02; done; cat "$root/completed.json"; printf '\\n' ) & ;;
  esac
done
`;
}

export type ManagementWorkspace = Readonly<{ root: string; claude: string; codex: string; workdir: McpServersWorkdir; claudeExecutable: string; codexExecutable: string }>;

export async function managementWorkspace(t: TestContext): Promise<ManagementWorkspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-management-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), claude = join(root, 'claude-fake'), codex = join(root, 'codex-fake');
  for (const directory of [cwd, claude, codex, join(claude, 'configured'), join(codex, 'configured')]) await mkdir(directory);
  const info = await lstat(cwd);
  return { root, claude, codex, workdir: { cwd, identity: { dev: info.dev, ino: info.ino } },
    claudeExecutable: await shellFixture(claude, 'claude', claudeManagementScript(claude)),
    codexExecutable: await shellFixture(codex, 'codex', codexManagementScript(codex)) };
}

export type CallbackListener = Readonly<{ port: number; requests: string[]; server: Server }>;

export async function callbackListener(t: TestContext, status = 200, onRequest: () => void = () => undefined): Promise<CallbackListener> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.host}`);
    onRequest();
    response.writeHead(status, { location: 'http://127.0.0.1:9/redirected' });
    response.end('Authentication complete.');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as AddressInfo).port, requests, server };
}

export type HeldListener = Readonly<{ port: number; requests: string[]; open: () => number }>;

export async function heldListener(t: TestContext, respond: (response: ServerResponse) => void = () => undefined): Promise<HeldListener> {
  const requests: string[] = [];
  const state = { open: 0 };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    respond(response);
  });
  server.on('connection', socket => {
    state.open++;
    socket.once('close', () => { state.open--; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as AddressInfo).port, requests, open: () => state.open };
}

export async function stdinRequests(root: string): Promise<Array<Record<string, unknown>>> {
  return (await lines(root, 'stdin')).map(entry => JSON.parse(entry) as Record<string, unknown>);
}

export async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < until, `${label} never happened`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
