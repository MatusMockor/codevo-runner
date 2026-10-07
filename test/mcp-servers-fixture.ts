import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MARKER = 'MARKER_SECRET';
export const CLAUDE_MCP_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--settings', '{"disableAllHooks":true}', '--no-session-persistence'];
export const CLAUDE_INITIALIZE_LINE = '{"type":"control_request","request_id":"codevo-mcp-servers-initialize","request":{"subtype":"initialize"}}';
export const CODEX_INITIALIZE_LINE = '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"codevo-runner","title":"Codevo Runner","version":"0.1.0"}}}';
export const claudeStatusLine = (poll: number) => `{"type":"control_request","request_id":"codevo-mcp-servers-status-${poll}","request":{"subtype":"mcp_status"}}`;

export type ShellFake = Readonly<{ initialize?: string; config?: string; status?: string }>;

const preamble = (root: string) => `#!/bin/sh
root='${root}'
echo $$ > "$root/pid"
echo launch >> "$root/launches"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$root/args"; done
env > "$root/env"
pwd > "$root/cwd"
sleep 600 &
echo $! > "$root/descendant-pid"
`;
const CLAUDE_INITIALIZED = `printf '%s\\n' '{"type":"control_response","response":{"subtype":"success","request_id":"codevo-mcp-servers-initialize","response":{"commands":[],"pid":4242}}}'`;
const CLAUDE_STATUS = `file="$root/servers-$polls.json"; [ -f "$file" ] || file="$root/servers.json"
      printf '{"type":"system","subtype":"status","request_id":"%s","mcp_servers":[{"name":"decoy","status":"connected"}]}\\n' "$id"
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":' "$id"; cat "$file"; printf '}}\\n'`;
const CODEX_INITIALIZED = `printf '%s\\n' '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}' '{"id":0,"result":{"userAgent":"synthetic"}}'`;
const CODEX_STATUS = `printf '{"id":1,"result":'; cat "$root/status.json"; printf '}\\n'`;
const CODEX_CONFIG = `printf '{"id":2,"result":'; cat "$root/config.json"; printf '}\\n'`;

export function claudeScript(root: string, fake: ShellFake = {}): string {
  return `${preamble(root)}polls=0
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$root/stdin"
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"subtype":"initialize"'*)
      ${fake.initialize ?? CLAUDE_INITIALIZED} ;;
    *'"subtype":"mcp_status"'*)
      polls=$((polls + 1))
      ${fake.status ?? CLAUDE_STATUS} ;;
  esac
done
`;
}

export function codexScript(root: string, fake: ShellFake = {}): string {
  return `${preamble(root)}while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$root/stdin"
  case "$line" in
    *'"method":"initialized"'*) ;;
    *'"method":"initialize"'*)
      ${fake.initialize ?? CODEX_INITIALIZED} ;;
    *'"method":"mcpServerStatus/list"'*)
      ${fake.status ?? CODEX_STATUS} ;;
    *'"method":"config/read"'*)
      ${fake.config ?? CODEX_CONFIG} ;;
  esac
done
`;
}

export function hangingScript(root: string): string {
  return `${preamble(root)}while IFS= read -r line; do :; done
sleep 600
`;
}

export async function shellFixture(root: string, name: string, script: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, script);
  await chmod(path, 0o700);
  return path;
}

export async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(root, name), JSON.stringify(value));
}

export async function lines(root: string, name: string): Promise<string[]> {
  const text = await readFile(join(root, name), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

export async function readPid(root: string, name = 'pid'): Promise<number> {
  const until = Date.now() + 8_000;
  for (;;) {
    const pid = Number((await lines(root, name))[0]);
    if (pid > 0) return pid;
    assert.ok(Date.now() < until, `${name} was never written`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export async function assertReaped(pid: number): Promise<void> {
  const until = Date.now() + 2_000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    if (Date.now() >= until) assert.fail(`Provider process ${pid} survived cleanup`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export async function assertTreeReaped(root: string): Promise<void> {
  await assertReaped(await readPid(root));
  await assertReaped(await readPid(root, 'descendant-pid'));
}

export const claudeServersWithSecrets = [
  { name: 'local-tools', status: 'failed', error: `failed to spawn \`/opt/${MARKER}/server --token ${MARKER}\`: API_TOKEN=${MARKER} sk_live_${MARKER}_0123456789abcdef`,
    config: { type: 'stdio', command: `/opt/${MARKER}/server`, args: ['--api-key', MARKER], env: { API_TOKEN: MARKER } },
    scope: 'project', source: `project-${MARKER}`, serverInfo: { name: MARKER, version: MARKER },
    tools: [{ name: `tool-${MARKER}`, description: MARKER, annotations: { title: MARKER } }] },
  { name: 'remote-tools', status: 'connected', pid: 4242, scope: 'user', tools: [{ name: MARKER, inputSchema: { description: MARKER } }, { name: 'second' }],
    config: { type: 'http', url: `https://user:${MARKER}@mcp.example.com:8443/v1/${MARKER}?token=${MARKER}#${MARKER}`, headers: { Authorization: `Bearer ${MARKER}` }, id: `mcpsrv_${MARKER}` } },
  { name: 'claude.ai Gmail', status: 'needs-auth', config: { type: 'claudeai-proxy', url: `https://gmailmcp.googleapis.com/mcp/v1/${MARKER}`, id: 'mcpsrv_01T' }, scope: 'claudeai' },
];
export const claudeSnapshotWithoutSecrets = { version: 1, provider: 'claude', truncated: false, servers: [
  { name: 'claude.ai Gmail', status: 'needsAuth', scope: 'account', transport: 'http', endpointOrigin: 'https://gmailmcp.googleapis.com', toolCount: null, detail: null },
  { name: 'local-tools', status: 'failed', scope: 'project', transport: 'stdio', endpointOrigin: null, toolCount: 1, detail: 'failed to spawn [redacted]' },
  { name: 'remote-tools', status: 'connected', scope: 'user', transport: 'http', endpointOrigin: 'https://mcp.example.com:8443', toolCount: 2, detail: null },
] };

const codexServer = (name: string, changed: Readonly<Record<string, unknown>>) => ({
  name, runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, tools: {}, toolsError: null,
  resources: [], resourceTemplates: [], authStatus: 'unsupported', ...changed,
});
export const codexConfigWithSecrets = { config: { model: MARKER, developer_instructions: MARKER, mcp_servers: {
  off: { command: `/opt/${MARKER}/server`, args: [MARKER], env: { API_TOKEN: MARKER }, enabled: false },
  broken: { command: `/opt/${MARKER}/broken`, enabled: false },
  codex_apps: { enabled: false },
  web: { url: `http://127.0.0.1:9/mcp/${MARKER}?token=${MARKER}`, http_headers: { Authorization: MARKER }, enabled: true },
} }, origins: { [`mcp_servers.off.command`]: { name: { type: 'user', file: `/home/${MARKER}/.codex/config.toml` } } } };
export const codexStatusWithSecrets = { nextCursor: null, data: [
  codexServer('web', { httpOrigin: 'http://127.0.0.1:9', authStatus: 'unknown',
    toolsError: `MCP startup failed: error sending request for url (http://127.0.0.1:9/mcp/${MARKER}?token=${MARKER}), when send initialize request` }),
  codexServer('off', {}),
  codexServer('broken', { toolsError: `failed to spawn /opt/${MARKER}/broken` }),
  codexServer('codex_apps', { httpOrigin: `https://user:${MARKER}@chatgpt.com/backend/${MARKER}`, pluginId: `plugin-${MARKER}`, serverInfo: { name: MARKER }, authStatus: 'bearerToken',
    serverCapabilities: { experimental: MARKER }, tools: { [MARKER]: { name: MARKER, description: MARKER, inputSchema: { title: MARKER } }, second: {} }, resources: [{ uri: MARKER }] }),
] };
export const codexSnapshotWithoutSecrets = { version: 1, provider: 'codex', truncated: false, servers: [
  { name: 'broken', status: 'disabled', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: 0, detail: null },
  { name: 'codex_apps', status: 'connected', scope: 'plugin', transport: 'http', endpointOrigin: 'https://chatgpt.com', toolCount: 2, detail: null },
  { name: 'off', status: 'disabled', scope: 'unknown', transport: 'stdio', endpointOrigin: null, toolCount: 0, detail: null },
  { name: 'web', status: 'failed', scope: 'unknown', transport: 'http', endpointOrigin: 'http://127.0.0.1:9', toolCount: 0,
    detail: 'MCP startup failed: error sending request for url (http://127.0.0.1:9 when send initialize request' },
] };
export const codexSnapshotWithoutConfig = { ...codexSnapshotWithoutSecrets, servers: [
  { ...codexSnapshotWithoutSecrets.servers[0]!, status: 'failed', detail: 'failed to spawn [redacted]' },
  codexSnapshotWithoutSecrets.servers[1]!,
  { ...codexSnapshotWithoutSecrets.servers[2]!, status: 'unknown' },
  codexSnapshotWithoutSecrets.servers[3]!,
] };
