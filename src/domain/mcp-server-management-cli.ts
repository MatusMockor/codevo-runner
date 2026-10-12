import type { McpServerAdd, McpServerLaunch, McpServerRemove } from './mcp-server-management.js';

export type McpCliOutcome = 'ok' | 'exists' | 'notFound' | 'unsupported' | 'failed';
export type McpCliPlan = Readonly<{
  args: readonly string[];
  outcome(exitCode: number | null, output: string): McpCliOutcome;
}>;

const LINE_BREAK = /\r?\n/;
const CODEX_LOGOUT_UNSUPPORTED = 'Error: OAuth logout is only supported for streamable_http transports.';

function hasLine(output: string, matches: (line: string) => boolean): boolean {
  return output.split(LINE_BREAK).some(matches);
}
function launchArgs(launch: McpServerLaunch): readonly string[] {
  switch (launch.kind) {
    case 'http': case 'sse': return [launch.url];
    case 'stdio': return [launch.command, ...launch.args];
  }
}

export function claudeMcpAddPlan(change: McpServerAdd): McpCliPlan {
  const existing = `MCP server ${change.name} already exists in `;
  return {
    args: ['mcp', 'add', '--scope', change.scope, '--transport', change.launch.kind, '--', change.name, ...launchArgs(change.launch)],
    outcome(exitCode, output) {
      if (exitCode === 0) return 'ok';
      if (exitCode === 1 && hasLine(output, line => line.startsWith(existing))) return 'exists';
      return 'failed';
    },
  };
}

export function claudeMcpRemovePlan(change: McpServerRemove): McpCliPlan {
  const missing = `No MCP server named "${change.name}" in `;
  return {
    args: ['mcp', 'remove', '--scope', change.scope, '--', change.name],
    outcome(exitCode, output) {
      if (exitCode === 0) return 'ok';
      if (exitCode === 1 && hasLine(output, line => line.startsWith(missing))) return 'notFound';
      return 'failed';
    },
  };
}

export function codexMcpRemovePlan(name: string): McpCliPlan {
  const missing = `No MCP server named '${name}' found.`;
  return {
    args: ['mcp', 'remove', '--', name],
    outcome(exitCode, output) {
      if (exitCode !== 0) return 'failed';
      if (hasLine(output, line => line === missing)) return 'notFound';
      return 'ok';
    },
  };
}

export function codexMcpLogoutPlan(name: string): McpCliPlan {
  const missing = `Error: No MCP server named '${name}' found in configuration.`;
  return {
    args: ['mcp', 'logout', '--', name],
    outcome(exitCode, output) {
      if (exitCode === 0) return 'ok';
      if (exitCode !== 1) return 'failed';
      if (hasLine(output, line => line === missing)) return 'notFound';
      if (hasLine(output, line => line === CODEX_LOGOUT_UNSUPPORTED)) return 'unsupported';
      return 'failed';
    },
  };
}
