import { isValidMcpAuthorizationUrl, type McpServerAdd, type McpServerLaunch, type McpServerLoginMode } from './mcp-server-management.js';
import { mcpRecord } from './mcp-servers.js';
import {
  CLAUDE_MCP_INITIALIZE_REQUEST_ID, CODEX_MCP_HANDSHAKE_REQUEST_ID, type McpProbeRequest,
} from './mcp-servers-probe.js';

export type McpManagementTiming = Readonly<{ retryMs: number; locateMs: number; pollMs: number; startMs: number }>;
export const MCP_MANAGEMENT_TIMING: McpManagementTiming = Object.freeze({ retryMs: 250, locateMs: 8_000, pollMs: 1_500, startMs: 25_000 });
export const CODEX_MCP_LOGIN_TIMEOUT_SECONDS = 300;
export const CODEX_MCP_REQUEST_ID = 1;
export const CODEX_MCP_WRITE_REQUEST_ID = 2;
export const CODEX_MCP_LOGIN_COMPLETED = 'mcpServer/oauthLogin/completed';

export type McpManagementFailure = 'handshake' | 'request' | 'payload' | 'timeout' | 'notFound' | 'exists' | 'unsupported';
export type McpChangeStep =
  | Readonly<{ kind: 'wait' }>
  | Readonly<{ kind: 'write'; requests: readonly McpProbeRequest[] }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'failed'; failure: McpManagementFailure }>;
export type McpLoginProgress =
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'finishInBrowser'; authorizationUrl: string }>
  | Readonly<{ kind: 'awaitingCallback'; authorizationUrl: string }>
  | Readonly<{ kind: 'succeeded' }>
  | Readonly<{ kind: 'failed'; failure: McpManagementFailure }>;
export type McpCallbackOutcome = 'idle' | 'pending' | 'accepted' | 'rejected';

const WAIT: McpChangeStep = Object.freeze({ kind: 'wait' });
const DONE: McpChangeStep = Object.freeze({ kind: 'done' });
const STARTING: McpLoginProgress = Object.freeze({ kind: 'starting' });
const NOTHING: readonly McpProbeRequest[] = Object.freeze([]);
const CODEX_INITIALIZED_NOTIFICATION: McpProbeRequest = Object.freeze({ method: 'initialized', params: Object.freeze({}) });
const CODEX_WRITTEN: readonly unknown[] = ['ok', 'okOverridden'];

type ClaudeControlBody = Readonly<Record<string, unknown>> & Readonly<{ request_id: string }>;
type ClaudeAnswer = 'ignored' | 'succeeded' | 'retry' | 'notFound' | 'refused';
type ClaudeRequestBody = (name: string) => Readonly<Record<string, unknown>>;

function jsonLine(line: string): Record<string, unknown> | null {
  try { return mcpRecord(JSON.parse(line)); } catch { return null; }
}
function claudeControlBody(line: string): ClaudeControlBody | null {
  const message = jsonLine(line);
  const body = message?.type === 'control_response' ? mcpRecord(message.response) : null;
  if (!body || typeof body.request_id !== 'string') return null;
  return body as ClaudeControlBody;
}
function claudeRequest(requestId: string, request: Readonly<Record<string, unknown>>): McpProbeRequest {
  return { type: 'control_request', request_id: requestId, request };
}
function failed(failure: McpManagementFailure): McpLoginProgress {
  return { kind: 'failed', failure };
}

export function claudeMcpClearAuthRequestId(attempt: number): string {
  return `codevo-mcp-clear-auth-${attempt}`;
}
export function claudeMcpAuthenticateRequestId(attempt: number): string {
  return `codevo-mcp-authenticate-${attempt}`;
}
export function claudeMcpLoginStatusRequestId(poll: number): string {
  return `codevo-mcp-login-status-${poll}`;
}
export function claudeMcpCallbackRequestId(submission: number): string {
  return `codevo-mcp-oauth-callback-${submission}`;
}
export function claudeMcpServerNotFound(name: string): string {
  return `Server not found: ${name}`;
}
export function codexMcpServerNotFound(name: string): string {
  return `No MCP server named '${name}' found.`;
}
export function codexMcpConfigReadRequest(cwd: string): McpProbeRequest {
  return { id: CODEX_MCP_REQUEST_ID, method: 'config/read', params: { cwd, includeLayers: false } };
}
function codexLaunchValue(launch: McpServerLaunch): Readonly<Record<string, unknown>> {
  switch (launch.kind) {
    case 'http': case 'sse': return { url: launch.url };
    case 'stdio': return { command: launch.command, args: [...launch.args] };
  }
}
export function codexMcpAddRequest(change: McpServerAdd): McpProbeRequest {
  return { id: CODEX_MCP_WRITE_REQUEST_ID, method: 'config/batchWrite',
    params: { edits: [{ keyPath: `mcp_servers.${change.name}`, mergeStrategy: 'replace', value: codexLaunchValue(change.launch) }] } };
}
export function codexMcpLoginRequest(name: string): McpProbeRequest {
  return { id: CODEX_MCP_REQUEST_ID, method: 'mcpServer/oauth/login', params: { name, timeoutSecs: CODEX_MCP_LOGIN_TIMEOUT_SECONDS } };
}

class ClaudeServerRequest {
  private attempts = 0;
  private outstanding: string | undefined;
  private retryAt: number;

  constructor(private readonly name: string, private readonly requestId: (attempt: number) => string, private readonly body: ClaudeRequestBody,
    private readonly locateUntil: number, private readonly retryMs: number, now: number) {
    this.retryAt = now;
  }

  next(now: number): readonly McpProbeRequest[] {
    if (this.outstanding !== undefined || now < this.retryAt) return NOTHING;
    this.attempts += 1;
    this.outstanding = this.requestId(this.attempts);
    return [claudeRequest(this.outstanding, this.body(this.name))];
  }

  answer(body: ClaudeControlBody, now: number): ClaudeAnswer {
    if (body.request_id !== this.outstanding) return 'ignored';
    this.outstanding = undefined;
    if (body.subtype === 'success') return 'succeeded';
    if (body.error !== claudeMcpServerNotFound(this.name)) return 'refused';
    if (now >= this.locateUntil) return 'notFound';
    this.retryAt = now + this.retryMs;
    return 'retry';
  }
}

const clearAuthBody: ClaudeRequestBody = serverName => ({ subtype: 'mcp_clear_auth', serverName });
const authenticateBody: ClaudeRequestBody = serverName => ({ subtype: 'mcp_authenticate', serverName });

export class ClaudeMcpSignOut {
  private request: ClaudeServerRequest | undefined;
  private failure: McpManagementFailure | undefined;
  private done = false;

  constructor(private readonly name: string, private readonly timing: McpManagementTiming = MCP_MANAGEMENT_TIMING) {}

  observe(line: string, now: number): void {
    if (this.done || this.failure) return;
    const body = claudeControlBody(line);
    if (!body) return;
    if (body.request_id === CLAUDE_MCP_INITIALIZE_REQUEST_ID) return this.observeInitialize(body.subtype === 'success', now);
    switch (this.request?.answer(body, now)) {
      case 'succeeded': this.done = true; return;
      case 'notFound': this.failure = 'notFound'; return;
      case 'refused': this.failure = 'unsupported'; return;
      case 'ignored': case 'retry': case undefined: return;
    }
  }

  step(now: number): McpChangeStep {
    if (this.failure) return { kind: 'failed', failure: this.failure };
    if (this.done) return DONE;
    const requests = this.request?.next(now) ?? NOTHING;
    if (requests.length === 0) return WAIT;
    return { kind: 'write', requests };
  }

  private observeInitialize(succeeded: boolean, now: number): void {
    if (!succeeded) { this.failure = 'handshake'; return; }
    this.request ??= new ClaudeServerRequest(this.name, claudeMcpClearAuthRequestId, clearAuthBody, now + this.timing.locateMs, this.timing.retryMs, now);
  }
}

type ClaudeLoginStage =
  | Readonly<{ kind: 'handshake' }>
  | Readonly<{ kind: 'clearing'; request: ClaudeServerRequest; locateUntil: number }>
  | Readonly<{ kind: 'authenticating'; request: ClaudeServerRequest }>
  | Readonly<{ kind: 'awaiting'; authorizationUrl: string }>
  | Readonly<{ kind: 'ended'; progress: McpLoginProgress }>;
type ClaudeCallback = Readonly<{ requestId: string; callbackUrl: string; sent: boolean }>;

export class ClaudeMcpLogin {
  private stage: ClaudeLoginStage = { kind: 'handshake' };
  private polls = 0;
  private outstandingPoll: string | undefined;
  private lastPollAt = 0;
  private callbackRequest: ClaudeCallback | undefined;
  private callbackOutcome: McpCallbackOutcome = 'idle';
  private submissions = 0;
  private acceptedAfterPoll: number | undefined;

  constructor(private readonly name: string, private readonly mode: McpServerLoginMode, private readonly startedAt: number,
    private readonly timing: McpManagementTiming = MCP_MANAGEMENT_TIMING) {}

  observe(line: string, now: number): void {
    const body = claudeControlBody(line);
    if (!body) return;
    switch (this.stage.kind) {
      case 'handshake': return this.observeInitialize(body, now);
      case 'clearing': return this.observeClear(this.stage.request, this.stage.locateUntil, body, now);
      case 'authenticating': return this.observeAuthenticate(this.stage.request, body, now);
      case 'awaiting': return this.observeAwaiting(body);
      case 'ended': return;
    }
  }

  step(now: number): readonly McpProbeRequest[] {
    switch (this.stage.kind) {
      case 'handshake': return this.starting(NOTHING, now);
      case 'clearing': case 'authenticating': return this.starting(this.stage.request.next(now), now);
      case 'awaiting': return [...this.callbackRequests(), ...this.pollRequests(now)];
      case 'ended': return NOTHING;
    }
  }

  progress(): McpLoginProgress {
    switch (this.stage.kind) {
      case 'handshake': case 'clearing': case 'authenticating': return STARTING;
      case 'awaiting': return { kind: 'awaitingCallback', authorizationUrl: this.stage.authorizationUrl };
      case 'ended': return this.stage.progress;
    }
  }

  submitCallback(callbackUrl: string): boolean {
    if (this.stage.kind !== 'awaiting' || this.callbackRequest) return false;
    this.submissions += 1;
    this.callbackRequest = { requestId: claudeMcpCallbackRequestId(this.submissions), callbackUrl, sent: false };
    this.callbackOutcome = 'pending';
    return true;
  }

  callback(): McpCallbackOutcome {
    return this.callbackOutcome;
  }

  private end(progress: McpLoginProgress): void {
    this.stage = { kind: 'ended', progress };
  }

  private starting(requests: readonly McpProbeRequest[], now: number): readonly McpProbeRequest[] {
    if (now - this.startedAt < this.timing.startMs) return requests;
    this.end(failed('timeout'));
    return NOTHING;
  }

  private authenticate(locateUntil: number, now: number): void {
    this.stage = { kind: 'authenticating',
      request: new ClaudeServerRequest(this.name, claudeMcpAuthenticateRequestId, authenticateBody, locateUntil, this.timing.retryMs, now) };
  }

  private observeInitialize(body: ClaudeControlBody, now: number): void {
    if (body.request_id !== CLAUDE_MCP_INITIALIZE_REQUEST_ID) return;
    if (body.subtype !== 'success') return this.end(failed('handshake'));
    const locateUntil = now + this.timing.locateMs;
    if (this.mode === 'signIn') return this.authenticate(locateUntil, now);
    this.stage = { kind: 'clearing', locateUntil,
      request: new ClaudeServerRequest(this.name, claudeMcpClearAuthRequestId, clearAuthBody, locateUntil, this.timing.retryMs, now) };
  }

  private observeClear(request: ClaudeServerRequest, locateUntil: number, body: ClaudeControlBody, now: number): void {
    switch (request.answer(body, now)) {
      case 'succeeded': case 'refused': return this.authenticate(locateUntil, now);
      case 'notFound': return this.end(failed('notFound'));
      case 'ignored': case 'retry': return;
    }
  }

  private observeAuthenticate(request: ClaudeServerRequest, body: ClaudeControlBody, now: number): void {
    switch (request.answer(body, now)) {
      case 'succeeded': return this.started(mcpRecord(body.response), now);
      case 'notFound': return this.end(failed('notFound'));
      case 'refused': return this.end(failed('unsupported'));
      case 'ignored': case 'retry': return;
    }
  }

  private started(response: Record<string, unknown> | null, now: number): void {
    if (response?.requiresUserAction === false) return this.end({ kind: 'completed' });
    const authorizationUrl = response?.authUrl;
    if (response?.requiresUserAction !== true || !isValidMcpAuthorizationUrl(authorizationUrl)) return this.end(failed('payload'));
    if (response.callbackExpected === false) return this.end({ kind: 'finishInBrowser', authorizationUrl });
    if (response.callbackExpected !== true) return this.end(failed('payload'));
    this.lastPollAt = now;
    this.stage = { kind: 'awaiting', authorizationUrl };
  }

  private observeAwaiting(body: ClaudeControlBody): void {
    if (body.request_id === this.callbackRequest?.requestId) return this.observeCallback(body.subtype === 'success');
    if (body.request_id !== this.outstandingPoll) return;
    this.outstandingPoll = undefined;
    if (body.subtype !== 'success') return;
    const servers = mcpRecord(body.response)?.mcpServers;
    if (!Array.isArray(servers)) return;
    const status = servers.map(mcpRecord).find(server => server?.name === this.name)?.status;
    if (status === 'connected') return this.end({ kind: 'succeeded' });
    if (status === 'failed' && this.acceptedAfterPoll !== undefined && this.polls > this.acceptedAfterPoll) this.end(failed('request'));
  }

  private observeCallback(accepted: boolean): void {
    this.callbackRequest = undefined;
    this.callbackOutcome = accepted ? 'accepted' : 'rejected';
    if (accepted) this.acceptedAfterPoll ??= this.polls;
  }

  private callbackRequests(): readonly McpProbeRequest[] {
    const callback = this.callbackRequest;
    if (!callback || callback.sent) return NOTHING;
    this.callbackRequest = { ...callback, sent: true };
    return [claudeRequest(callback.requestId, { subtype: 'mcp_oauth_callback_url', serverName: this.name, callbackUrl: callback.callbackUrl })];
  }

  private pollRequests(now: number): readonly McpProbeRequest[] {
    if (this.outstandingPoll !== undefined || now - this.lastPollAt < this.timing.pollMs) return NOTHING;
    this.polls += 1;
    this.lastPollAt = now;
    this.outstandingPoll = claudeMcpLoginStatusRequestId(this.polls);
    return [claudeRequest(this.outstandingPoll, { subtype: 'mcp_status' })];
  }
}

type CodexAddStage = 'handshake' | 'initialized' | 'reading' | 'absent' | 'writing' | 'done';

export class CodexMcpAdd {
  private stage: CodexAddStage = 'handshake';
  private failure: McpManagementFailure | undefined;

  constructor(private readonly change: McpServerAdd, private readonly cwd: string) {}

  observe(line: string): void {
    if (this.failure || this.stage === 'done') return;
    const message = jsonLine(line);
    if (!message || 'method' in message) return;
    if (message.id === CODEX_MCP_HANDSHAKE_REQUEST_ID) return this.observeHandshake(message);
    if (message.id === CODEX_MCP_REQUEST_ID) return this.observeConfig(message);
    if (message.id === CODEX_MCP_WRITE_REQUEST_ID) return this.observeWrite(message);
  }

  step(): McpChangeStep {
    if (this.failure) return { kind: 'failed', failure: this.failure };
    switch (this.stage) {
      case 'handshake': case 'reading': case 'writing': return WAIT;
      case 'initialized':
        this.stage = 'reading';
        return { kind: 'write', requests: [CODEX_INITIALIZED_NOTIFICATION, codexMcpConfigReadRequest(this.cwd)] };
      case 'absent':
        this.stage = 'writing';
        return { kind: 'write', requests: [codexMcpAddRequest(this.change)] };
      case 'done': return DONE;
    }
  }

  private observeHandshake(message: Record<string, unknown>): void {
    if (this.stage !== 'handshake') return;
    if ('error' in message) { this.failure = 'handshake'; return; }
    if ('result' in message) this.stage = 'initialized';
  }

  private observeConfig(message: Record<string, unknown>): void {
    if (this.stage !== 'reading') return;
    if ('error' in message) { this.failure = 'request'; return; }
    const configured = mcpRecord(mcpRecord(mcpRecord(message.result)?.config)?.mcp_servers);
    if (!configured) { this.failure = 'payload'; return; }
    if (Object.hasOwn(configured, this.change.name)) { this.failure = 'exists'; return; }
    this.stage = 'absent';
  }

  private observeWrite(message: Record<string, unknown>): void {
    if (this.stage !== 'writing') return;
    if ('error' in message) { this.failure = 'request'; return; }
    if (!CODEX_WRITTEN.includes(mcpRecord(message.result)?.status)) { this.failure = 'payload'; return; }
    this.stage = 'done';
  }
}

type CodexLoginStage =
  | Readonly<{ kind: 'handshake' }>
  | Readonly<{ kind: 'initialized' }>
  | Readonly<{ kind: 'requesting' }>
  | Readonly<{ kind: 'awaiting'; authorizationUrl: string; loginId: string | null }>
  | Readonly<{ kind: 'ended'; progress: McpLoginProgress }>;

export class CodexMcpLogin {
  private stage: CodexLoginStage = { kind: 'handshake' };

  constructor(private readonly name: string, private readonly startedAt: number, private readonly timing: McpManagementTiming = MCP_MANAGEMENT_TIMING) {}

  observe(line: string): void {
    if (this.stage.kind === 'ended') return;
    const message = jsonLine(line);
    if (!message) return;
    if (message.method === CODEX_MCP_LOGIN_COMPLETED) return this.observeCompleted(mcpRecord(message.params));
    if ('method' in message) return;
    if (message.id === CODEX_MCP_HANDSHAKE_REQUEST_ID) return this.observeHandshake(message);
    if (message.id === CODEX_MCP_REQUEST_ID) return this.observeLogin(message);
  }

  step(now: number): readonly McpProbeRequest[] {
    switch (this.stage.kind) {
      case 'handshake': case 'requesting': return this.starting(NOTHING, now);
      case 'initialized':
        this.stage = { kind: 'requesting' };
        return this.starting([CODEX_INITIALIZED_NOTIFICATION, codexMcpLoginRequest(this.name)], now);
      case 'awaiting': case 'ended': return NOTHING;
    }
  }

  progress(): McpLoginProgress {
    switch (this.stage.kind) {
      case 'handshake': case 'initialized': case 'requesting': return STARTING;
      case 'awaiting': return { kind: 'awaitingCallback', authorizationUrl: this.stage.authorizationUrl };
      case 'ended': return this.stage.progress;
    }
  }

  private end(progress: McpLoginProgress): void {
    this.stage = { kind: 'ended', progress };
  }

  private starting(requests: readonly McpProbeRequest[], now: number): readonly McpProbeRequest[] {
    if (now - this.startedAt < this.timing.startMs) return requests;
    this.end(failed('timeout'));
    return NOTHING;
  }

  private observeHandshake(message: Record<string, unknown>): void {
    if (this.stage.kind !== 'handshake') return;
    if ('error' in message) return this.end(failed('handshake'));
    if ('result' in message) this.stage = { kind: 'initialized' };
  }

  private observeLogin(message: Record<string, unknown>): void {
    if (this.stage.kind !== 'requesting') return;
    if ('error' in message) return this.end(failed(mcpRecord(message.error)?.message === codexMcpServerNotFound(this.name) ? 'notFound' : 'unsupported'));
    const result = mcpRecord(message.result);
    const authorizationUrl = result?.authorizationUrl;
    if (!isValidMcpAuthorizationUrl(authorizationUrl)) return this.end(failed('payload'));
    this.stage = { kind: 'awaiting', authorizationUrl, loginId: typeof result?.loginId === 'string' ? result.loginId : null };
  }

  private observeCompleted(params: Record<string, unknown> | null): void {
    if (this.stage.kind !== 'awaiting' || params?.name !== this.name) return;
    if (this.stage.loginId !== null && typeof params.loginId === 'string' && params.loginId !== this.stage.loginId) return;
    this.end(params.success === true ? { kind: 'succeeded' } : failed('request'));
  }
}
