import type { McpServersReader, McpServersWorkdir } from '../../application/mcp-servers-service.js';
import type { McpServers, McpServersProvider } from '../../domain/mcp-servers.js';
import {
  CLAUDE_MCP_INITIALIZE_REQUEST, CODEX_MCP_INITIALIZE_REQUEST, ClaudeMcpStatusPoll, CodexMcpStatusRequest, MCP_STATUS_TIMING,
  type McpProbeStep, type McpStatusTiming,
} from '../../domain/mcp-servers-probe.js';
import { runUsageProcess, type UsageProcessLaunch, type UsageProcessOptions } from './account-usage-process.js';
import { providerEnvironment } from './cli-executor.js';
import { executable } from './command-catalog.js';

export const MCP_SERVERS_PROBE_TIMEOUT_MS = 25_000;
export const MCP_SERVERS_PROBE_BYTES = Object.freeze({
  claude: Object.freeze({ outputBytes: 16 * 1024 * 1024, lineBytes: 2 * 1024 * 1024 }),
  codex: Object.freeze({ outputBytes: 16 * 1024 * 1024, lineBytes: 8 * 1024 * 1024 }),
});
export type McpServersCliOptions = UsageProcessOptions & Readonly<{ timing?: Partial<McpStatusTiming> }>;

const TIMEOUT_GRACE_MS = 1_000;
const MAX_TICK_MS = 50;
const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--settings', '{"disableAllHooks":true}', '--no-session-persistence'] as const;
const CLAUDE_ENV = { CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' } as const;
const CODEX_ARGS = ['app-server', '--stdio'] as const;

type Write = (value: unknown) => void;

function apply(step: McpProbeStep, write: Write): boolean {
  switch (step.kind) {
    case 'wait': return false;
    case 'write':
      step.requests.forEach(request => write(request));
      return false;
    case 'done': return true;
    case 'failed': throw new Error(`mcp_servers_${step.failure}`);
  }
}
function required(snapshot: McpServers | undefined): McpServers {
  if (!snapshot) throw new Error('mcp_servers_unavailable');
  return snapshot;
}
function line(request: unknown): string {
  return JSON.stringify(request) + '\n';
}

export class CliMcpServersReader implements McpServersReader {
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly timeoutMs: number;
  private readonly timing: McpStatusTiming;

  constructor(options: McpServersCliOptions = {}) {
    this.claudeExecutable = executable(options.claudeExecutable, 'claude');
    this.codexExecutable = executable(options.codexExecutable, 'codex');
    this.timeoutMs = options.timeoutMs ?? MCP_SERVERS_PROBE_TIMEOUT_MS;
    this.timing = { ...MCP_STATUS_TIMING, ...options.timing };
    if ([this.timeoutMs, ...Object.values(this.timing)].some(value => !Number.isFinite(value) || value < 1)) throw new Error('invalid_mcp_servers_timing');
  }

  async read(provider: McpServersProvider, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServers> {
    const snapshot = await this.probe(provider, workdir, signal);
    signal.throwIfAborted();
    return snapshot;
  }

  private probe(provider: McpServersProvider, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServers> {
    switch (provider) {
      case 'claude': return this.claude(workdir, signal);
      case 'codex': return this.codex(workdir, signal);
    }
  }

  private launch(provider: McpServersProvider, workdir: McpServersWorkdir, env: NodeJS.ProcessEnv, ceilingMs: number): UsageProcessLaunch {
    return { cwd: workdir.cwd, cwdIdentity: workdir.identity, env: { ...providerEnvironment(), ...env },
      ...MCP_SERVERS_PROBE_BYTES[provider], ceilingMs, rejectNonZeroExit: true };
  }

  private async claude(workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServers> {
    const poll = new ClaudeMcpStatusPoll(this.timing);
    const startedAt = performance.now();
    const hardTimeoutMs = this.timeoutMs + TIMEOUT_GRACE_MS;
    const advance = (write: Write): boolean => {
      const now = performance.now();
      if (now - startedAt >= this.timeoutMs) return Boolean(required(poll.snapshot()));
      return apply(poll.step(now), write);
    };
    await runUsageProcess(this.claudeExecutable, CLAUDE_ARGS, {
      initialInput: line(CLAUDE_MCP_INITIALIZE_REQUEST),
      tickMs: Math.max(1, Math.min(MAX_TICK_MS, Math.floor(this.timing.pollMs / 4))),
      onTick: advance,
      onLine: (text, write) => {
        poll.observe(text, performance.now());
        return advance(write);
      },
    }, signal, hardTimeoutMs, this.launch('claude', workdir, CLAUDE_ENV, hardTimeoutMs));
    return required(poll.snapshot());
  }

  private async codex(workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServers> {
    const request = new CodexMcpStatusRequest(workdir.cwd, this.timing);
    const advance = (write: Write): boolean => apply(request.step(performance.now()), write);
    try {
      await runUsageProcess(this.codexExecutable, CODEX_ARGS, {
        initialInput: line(CODEX_MCP_INITIALIZE_REQUEST),
        tickMs: MAX_TICK_MS,
        onTick: advance,
        onLine: (text, write) => {
          request.observe(text);
          return advance(write);
        },
      }, signal, this.timeoutMs, this.launch('codex', workdir, {}, this.timeoutMs));
    } catch (error) {
      if (!request.snapshot()) throw error;
    }
    return required(request.snapshot());
  }
}
