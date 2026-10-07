import {
  MCP_SERVERS_LIMITS, markCodexDisabledMcpServers, mcpRecord, parseClaudeMcpServers, parseCodexMcpServers, type McpServers,
} from './mcp-servers.js';

export type McpStatusTiming = Readonly<{ pollMs: number; stableMs: number; settleMs: number; configMs: number }>;
export const MCP_STATUS_TIMING: McpStatusTiming = Object.freeze({ pollMs: 500, stableMs: 2_000, settleMs: 20_000, configMs: 5_000 });
export const MAX_CLAUDE_MCP_STATUS_POLLS = 48;
export const CLAUDE_MCP_INITIALIZE_REQUEST_ID = 'codevo-mcp-servers-initialize';
export const CODEX_MCP_HANDSHAKE_REQUEST_ID = 0;
export const CODEX_MCP_STATUS_REQUEST_ID = 1;
export const CODEX_MCP_CONFIG_REQUEST_ID = 2;

export type McpProbeRequest = Readonly<Record<string, unknown>>;
export type McpProbeFailure = 'handshake' | 'request' | 'payload';
export type McpProbeStep =
  | Readonly<{ kind: 'wait' }>
  | Readonly<{ kind: 'write'; requests: readonly McpProbeRequest[] }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'failed'; failure: McpProbeFailure }>;

export const CLAUDE_MCP_INITIALIZE_REQUEST: McpProbeRequest = Object.freeze({
  type: 'control_request', request_id: CLAUDE_MCP_INITIALIZE_REQUEST_ID, request: Object.freeze({ subtype: 'initialize' }),
});
export const CODEX_MCP_INITIALIZE_REQUEST: McpProbeRequest = Object.freeze({
  id: CODEX_MCP_HANDSHAKE_REQUEST_ID, method: 'initialize',
  params: Object.freeze({ clientInfo: Object.freeze({ name: 'codevo-runner', title: 'Codevo Runner', version: '0.1.0' }) }),
});
const CODEX_INITIALIZED_NOTIFICATION: McpProbeRequest = Object.freeze({ method: 'initialized', params: Object.freeze({}) });
const CODEX_MCP_STATUS_REQUEST: McpProbeRequest = Object.freeze({
  id: CODEX_MCP_STATUS_REQUEST_ID, method: 'mcpServerStatus/list',
  params: Object.freeze({ detail: 'toolsAndAuthOnly', limit: MCP_SERVERS_LIMITS.maxServers }),
});
const WAIT: McpProbeStep = Object.freeze({ kind: 'wait' });
const DONE: McpProbeStep = Object.freeze({ kind: 'done' });

export function claudeMcpStatusRequestId(poll: number): string {
  return `codevo-mcp-servers-status-${poll}`;
}
export function claudeMcpStatusRequest(requestId: string): McpProbeRequest {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'mcp_status' } };
}
export function codexMcpConfigRequest(cwd: string): McpProbeRequest {
  return { id: CODEX_MCP_CONFIG_REQUEST_ID, method: 'config/read', params: { cwd, includeLayers: false } };
}

function jsonLine(line: string): Record<string, unknown> | null {
  try { return mcpRecord(JSON.parse(line)); } catch { return null; }
}
function attempt<T>(parse: () => T): T | undefined {
  try { return parse(); } catch { return undefined; }
}

export class ClaudeMcpStatusPoll {
  private initializedAt: number | undefined;
  private polls = 0;
  private outstanding: string | undefined;
  private lastSentAt: number | undefined;
  private latest: McpServers | undefined;
  private latestKey: string | undefined;
  private stableSince: number | undefined;
  private confirmedAt: number | undefined;
  private failure: McpProbeFailure | undefined;
  private done = false;

  constructor(private readonly timing: McpStatusTiming = MCP_STATUS_TIMING) {}

  observe(line: string, now: number): void {
    if (this.done || this.failure) return;
    const message = jsonLine(line);
    const body = message?.type === 'control_response' ? mcpRecord(message.response) : null;
    if (!body || typeof body.request_id !== 'string') return;
    const succeeded = body.subtype === 'success';
    if (body.request_id === CLAUDE_MCP_INITIALIZE_REQUEST_ID) return this.observeInitialize(succeeded, now);
    if (body.request_id !== this.outstanding) return;
    this.outstanding = undefined;
    if (!succeeded) { this.failure = 'request'; return; }
    this.accept(attempt(() => parseClaudeMcpServers(body.response)), now);
  }

  step(now: number): McpProbeStep {
    if (this.failure) return { kind: 'failed', failure: this.failure };
    if (this.done) return DONE;
    if (this.initializedAt === undefined) return WAIT;
    const expired = this.expired(this.initializedAt, now);
    if (this.latest && (expired || this.settled())) {
      this.done = true;
      return DONE;
    }
    if (expired || this.outstanding !== undefined || !this.pollDue(now)) return WAIT;
    this.polls += 1;
    this.outstanding = claudeMcpStatusRequestId(this.polls);
    this.lastSentAt = now;
    return { kind: 'write', requests: [claudeMcpStatusRequest(this.outstanding)] };
  }

  snapshot(): McpServers | undefined {
    return this.latest;
  }

  private observeInitialize(succeeded: boolean, now: number): void {
    if (!succeeded) { this.failure = 'handshake'; return; }
    this.initializedAt ??= now;
  }

  private accept(snapshot: McpServers | undefined, now: number): void {
    if (!snapshot) { this.failure = 'payload'; return; }
    const key = JSON.stringify(snapshot);
    if (key !== this.latestKey) this.stableSince = now;
    this.confirmedAt = now;
    this.latest = snapshot;
    this.latestKey = key;
  }

  private settled(): boolean {
    if (!this.latest || this.stableSince === undefined || this.confirmedAt === undefined) return false;
    if (this.latest.servers.some(server => server.status === 'connecting')) return false;
    return this.confirmedAt - this.stableSince >= this.timing.stableMs;
  }

  private expired(initializedAt: number, now: number): boolean {
    return now - initializedAt >= this.timing.settleMs || (this.polls >= MAX_CLAUDE_MCP_STATUS_POLLS && this.outstanding === undefined);
  }

  private pollDue(now: number): boolean {
    return this.lastSentAt === undefined || now - this.lastSentAt >= this.timing.pollMs;
  }
}

type CodexStage =
  | Readonly<{ kind: 'handshake' }>
  | Readonly<{ kind: 'initialized' }>
  | Readonly<{ kind: 'status' }>
  | Readonly<{ kind: 'listed'; snapshot: McpServers }>
  | Readonly<{ kind: 'config'; snapshot: McpServers; requestedAt: number }>
  | Readonly<{ kind: 'done'; snapshot: McpServers }>;

export class CodexMcpStatusRequest {
  private stage: CodexStage = { kind: 'handshake' };
  private failure: McpProbeFailure | undefined;

  constructor(private readonly cwd: string, private readonly timing: McpStatusTiming = MCP_STATUS_TIMING) {}

  observe(line: string): void {
    if (this.failure || this.stage.kind === 'done') return;
    const message = jsonLine(line);
    if (!message || 'method' in message) return;
    if (message.id === CODEX_MCP_HANDSHAKE_REQUEST_ID) return this.observeHandshake(message);
    if (message.id === CODEX_MCP_STATUS_REQUEST_ID) return this.observeStatus(message);
    if (message.id === CODEX_MCP_CONFIG_REQUEST_ID) return this.observeConfig(message);
  }

  step(now: number): McpProbeStep {
    if (this.failure) return { kind: 'failed', failure: this.failure };
    switch (this.stage.kind) {
      case 'handshake': case 'status': return WAIT;
      case 'initialized':
        this.stage = { kind: 'status' };
        return { kind: 'write', requests: [CODEX_INITIALIZED_NOTIFICATION, CODEX_MCP_STATUS_REQUEST] };
      case 'listed':
        this.stage = { kind: 'config', snapshot: this.stage.snapshot, requestedAt: now };
        return { kind: 'write', requests: [codexMcpConfigRequest(this.cwd)] };
      case 'config': return this.awaitConfig(this.stage.snapshot, this.stage.requestedAt, now);
      case 'done': return DONE;
    }
  }

  snapshot(): McpServers | undefined {
    switch (this.stage.kind) {
      case 'handshake': case 'initialized': case 'status': return undefined;
      case 'listed': case 'config': case 'done': return this.stage.snapshot;
    }
  }

  private awaitConfig(snapshot: McpServers, requestedAt: number, now: number): McpProbeStep {
    if (now - requestedAt < this.timing.configMs) return WAIT;
    this.stage = { kind: 'done', snapshot };
    return DONE;
  }

  private observeHandshake(message: Record<string, unknown>): void {
    if (this.stage.kind !== 'handshake') return;
    if ('error' in message) { this.failure = 'handshake'; return; }
    if ('result' in message) this.stage = { kind: 'initialized' };
  }

  private observeStatus(message: Record<string, unknown>): void {
    if (this.stage.kind !== 'status') return;
    if ('error' in message) { this.failure = 'request'; return; }
    const snapshot = attempt(() => parseCodexMcpServers(message.result));
    if (!snapshot) { this.failure = 'payload'; return; }
    this.stage = { kind: 'listed', snapshot };
  }

  private observeConfig(message: Record<string, unknown>): void {
    if (this.stage.kind !== 'config') return;
    const listed = this.stage.snapshot;
    const snapshot = 'error' in message ? listed : attempt(() => markCodexDisabledMcpServers(listed, message.result)) ?? listed;
    this.stage = { kind: 'done', snapshot };
  }
}
