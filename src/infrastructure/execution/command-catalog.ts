import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { CommandCatalogReader, CommandCatalogWorkdir } from '../../application/command-catalog-service.js';
import {
  COMMAND_CATALOG_LIMITS, parseClaudeCommands, parseCodexSkills, type CommandCatalog, type CommandCatalogProvider,
} from '../../domain/command-catalog.js';
import { runUsageProcess, type UsageProcessLaunch, type UsageProcessOptions } from './account-usage-process.js';
import { providerEnvironment } from './cli-executor.js';

/** Codex loads user and plugin skills after startup without a completion signal, so one
 * app-server is polled until the listed names stop changing or the hard cap is reached. */
export type CodexSkillSettle = Readonly<{ pollMs: number; settleMs: number; capMs: number }>;
export const CODEX_SKILL_SETTLE: CodexSkillSettle = Object.freeze({ pollMs: 400, settleMs: 2_000, capMs: 6_000 });
export const CODEX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;
export type CommandCatalogCliOptions = UsageProcessOptions & Readonly<{ codexSettle?: Partial<CodexSkillSettle> }>;

const CEILING_MS: Readonly<Record<CommandCatalogProvider, number>> = { claudeCode: 20_000, codex: 15_000 };
const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--no-session-persistence'] as const;
const CLAUDE_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' } as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function executable(configured: string | undefined, fallback: string): string {
  const value = configured ?? fallback;
  if (!value || value.includes('\0') || (value !== fallback && !isAbsolute(value))) throw new Error('invalid_provider_executable');
  return value;
}

/** Probes run with the executable lookup, environment allowlist and pinned checkout of a task launch. */
export class CliCommandCatalogReader implements CommandCatalogReader {
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly timeoutMs: number | undefined;
  private readonly settle: CodexSkillSettle;

  constructor(options: CommandCatalogCliOptions = {}) {
    this.claudeExecutable = executable(options.claudeExecutable, 'claude');
    this.codexExecutable = executable(options.codexExecutable, 'codex');
    this.timeoutMs = options.timeoutMs;
    this.settle = { ...CODEX_SKILL_SETTLE, ...options.codexSettle };
    if (Object.values(this.settle).some(value => !Number.isFinite(value) || value < 1)) throw new Error('invalid_codex_settle');
  }

  async read(provider: CommandCatalogProvider, workdir: CommandCatalogWorkdir, signal: AbortSignal): Promise<CommandCatalog> {
    const catalog = provider === 'claudeCode' ? await this.claude(workdir, signal) : await this.codex(workdir, signal);
    signal.throwIfAborted();
    return catalog;
  }

  private launch(provider: CommandCatalogProvider, workdir: CommandCatalogWorkdir, env: NodeJS.ProcessEnv): UsageProcessLaunch {
    return { cwd: workdir.cwd, cwdIdentity: workdir.identity, env: { ...providerEnvironment(), ...env },
      outputBytes: COMMAND_CATALOG_LIMITS.outputBytes, ceilingMs: CEILING_MS[provider], rejectNonZeroExit: true };
  }

  private async claude(workdir: CommandCatalogWorkdir, signal: AbortSignal): Promise<CommandCatalog> {
    const requestId = randomUUID();
    const output = await runUsageProcess(this.claudeExecutable, CLAUDE_ARGS,
      { initialInput: JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n' },
      signal, this.timeoutMs ?? CEILING_MS.claudeCode, this.launch('claudeCode', workdir, CLAUDE_ENV));
    return parseClaudeCommands(output, requestId);
  }

  private async codex(workdir: CommandCatalogWorkdir, signal: AbortSignal): Promise<CommandCatalog> {
    const { pollMs, settleMs, capMs } = this.settle;
    let awaited: number | undefined = 0;
    let nextId = 1, sentAt = 0, changedAt = 0;
    let readyAt: number | undefined;
    let latest: CommandCatalog | undefined;
    let listed: string | undefined;
    const poll = (write: (value: unknown) => void) => {
      awaited = nextId++;
      sentAt = performance.now();
      write({ id: awaited, method: 'skills/list', params: { cwds: [workdir.cwd] } });
    };
    await runUsageProcess(this.codexExecutable, ['app-server', '--stdio'], {
      initialInput: JSON.stringify({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codevo-runner', title: 'Codevo Runner', version: '0.1.0' } } }) + '\n',
      tickMs: Math.max(1, Math.min(50, Math.floor(pollMs / 4))),
      onTick: write => {
        if (readyAt === undefined) return false;
        const now = performance.now();
        if (latest && now - readyAt >= capMs) return true;
        if (awaited === undefined && now - sentAt >= pollMs) poll(write);
        return false;
      },
      onLine: (line, write) => {
        if (!line.trim()) return false;
        const message = record(JSON.parse(line));
        if (!message || 'method' in message || message.id === undefined || message.id !== awaited) return false;
        if (!('result' in message) || 'error' in message) throw new Error('catalog_unavailable');
        const now = performance.now();
        if (readyAt === undefined) {
          write({ method: 'initialized', params: {} });
          readyAt = now;
          poll(write);
          return false;
        }
        awaited = undefined;
        const catalog = parseCodexSkills(message.result, workdir.cwd);
        const names = catalog.entries.map(entry => entry.name).join('\n');
        if (latest === undefined || names !== listed) changedAt = now;
        latest = catalog;
        listed = names;
        return now - changedAt >= settleMs || now - readyAt >= capMs;
      },
    }, signal, this.timeoutMs ?? CEILING_MS.codex, { ...this.launch('codex', workdir, {}), outputBytes: CODEX_PROBE_OUTPUT_BYTES, lineBytes: COMMAND_CATALOG_LIMITS.outputBytes });
    if (!latest) throw new Error('catalog_unavailable');
    return latest;
  }
}
