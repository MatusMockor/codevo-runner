import { randomUUID } from 'node:crypto';
import { RunnerError } from '../domain/contracts.js';
import type { RegisteredProject } from '../domain/execution.js';
import {
  isMcpServerChangeSupported, isMcpServerLoginId, isMcpServerManagementError, isValidMcpAuthorizationUrl, parseMcpServerChangeRequest,
  parseMcpServerLoginCallback, parseMcpServerLoginRequest, type McpServerChange, type McpServerChanged, type McpServerLoginRequest,
  type McpServerLoginStarted, type McpServerLoginState, type McpServerLoginStatus, type McpServerLoginStep,
} from '../domain/mcp-server-management.js';
import type { McpServersProvider } from '../domain/mcp-servers.js';
import type { ProjectRegistry, WorkSource } from './execution-ports.js';
import type { GitWorkspaces } from './git-sync-ports.js';
import { mcpServersCheckout, mcpServersProject, type McpServersWorkdir } from './mcp-servers-service.js';

export interface McpServerLoginProcess {
  readonly finished: Promise<void>;
  state(): McpServerLoginState;
  submitCallback(callbackUrl: string): Promise<boolean>;
}
export type McpServerLoginAttempt =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'finishInBrowser'; authorizationUrl: string }>
  | Readonly<{ kind: 'awaitingCallback'; authorizationUrl: string; process: McpServerLoginProcess }>;
export interface McpServerManager {
  change(provider: McpServersProvider, change: McpServerChange, workdir: McpServersWorkdir, signal: AbortSignal): Promise<void>;
  login(provider: McpServersProvider, request: McpServerLoginRequest, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServerLoginAttempt>;
}
export interface McpServerManagementApplication {
  change(projectId: string, provider: McpServersProvider, input: unknown): Promise<McpServerChanged>;
  startLogin(projectId: string, provider: McpServersProvider, input: unknown, disconnected: AbortSignal): Promise<McpServerLoginStarted>;
  loginState(projectId: string, provider: McpServersProvider, loginId: string): Promise<McpServerLoginStatus>;
  submitLoginCallback(projectId: string, provider: McpServersProvider, loginId: string, input: unknown): Promise<McpServerChanged>;
  cancelLogin(projectId: string, provider: McpServersProvider, loginId: string): Promise<McpServerChanged>;
  close(): Promise<void>;
}

export type McpServerManagementPolicy = Readonly<{
  concurrentChanges: number; checkoutMs: number; loginDeadlineMs: number; loginRetentionMs: number; retainedLogins: number;
}>;
export const MCP_SERVER_MANAGEMENT_POLICY: McpServerManagementPolicy = Object.freeze({
  concurrentChanges: 1, checkoutMs: 5_000, loginDeadlineMs: 300_000, loginRetentionMs: 60_000, retainedLogins: 16,
});
export type McpServerManagementOptions = Readonly<{ policy?: Partial<McpServerManagementPolicy> }>;

type LoginPhase =
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'pending'; process: McpServerLoginProcess }>
  | Readonly<{ kind: 'finished'; state: Exclude<McpServerLoginState, 'pending'> }>;

class LoginSession {
  readonly loginId = randomUUID();
  readonly controller = new AbortController();
  readonly settled: Promise<void>;
  phase: LoginPhase = { kind: 'starting' };
  timer: NodeJS.Timeout | undefined;
  delivering = false;
  private resolve: () => void = () => undefined;

  constructor(readonly projectId: string, readonly provider: McpServersProvider) {
    this.settled = new Promise(resolve => { this.resolve = resolve; });
  }

  settle(): void {
    clearTimeout(this.timer);
    this.resolve();
  }
}

const CHANGED: McpServerChanged = Object.freeze({ version: 1 });
const ignore = () => undefined;

function reported(error: unknown): RunnerError {
  if (error instanceof RunnerError && isMcpServerManagementError(error.code)) return error;
  return new RunnerError('storage_unavailable');
}

export class McpServerManagementService implements McpServerManagementApplication, WorkSource {
  private readonly changes = new Set<Promise<void>>();
  private readonly settling = new Set<Promise<void>>();
  private readonly deliveries = new Set<Promise<boolean | undefined>>();
  private readonly sessions = new Map<string, LoginSession>();
  private readonly cancellation = new AbortController();
  private readonly policy: McpServerManagementPolicy;
  private active: LoginSession | undefined;

  constructor(
    private readonly projects: Pick<ProjectRegistry, 'get'>,
    private readonly workspaces: Pick<GitWorkspaces, 'checkout'>,
    private readonly manager: McpServerManager,
    options: McpServerManagementOptions = {},
  ) {
    this.policy = { ...MCP_SERVER_MANAGEMENT_POLICY, ...options.policy };
  }

  get working(): boolean { return this.changes.size > 0 || this.settling.size > 0; }

  async change(projectId: string, provider: McpServersProvider, input: unknown): Promise<McpServerChanged> {
    const change = parseMcpServerChangeRequest(input);
    if (!isMcpServerChangeSupported(provider, change)) throw new RunnerError('mcp_change_unsupported');
    this.assertOpen();
    const project = await mcpServersProject(this.projects, projectId);
    this.assertOpen();
    if (this.changes.size >= this.policy.concurrentChanges) throw new RunnerError('busy');
    const applied = this.apply(project, provider, change, this.cancellation.signal);
    this.changes.add(applied);
    try { await applied; }
    catch (error) { throw reported(error); }
    finally { this.changes.delete(applied); }
    return CHANGED;
  }

  async startLogin(projectId: string, provider: McpServersProvider, input: unknown, disconnected: AbortSignal): Promise<McpServerLoginStarted> {
    const request = parseMcpServerLoginRequest(input);
    this.assertOpen(disconnected);
    const project = await mcpServersProject(this.projects, projectId);
    this.assertOpen(disconnected);
    const session = new LoginSession(projectId, provider);
    const abandon = () => session.controller.abort();
    disconnected.addEventListener('abort', abandon, { once: true });
    try { return { version: 1, step: await this.begin(session, project, request) }; }
    catch (error) { throw reported(error); }
    finally { disconnected.removeEventListener('abort', abandon); }
  }

  async loginState(projectId: string, provider: McpServersProvider, loginId: string): Promise<McpServerLoginStatus> {
    const session = await this.located(projectId, provider, loginId);
    if (!session) throw new RunnerError('mcp_login_inactive');
    return { version: 1, state: this.state(session) };
  }

  async submitLoginCallback(projectId: string, provider: McpServersProvider, loginId: string, input: unknown): Promise<McpServerChanged> {
    const callbackUrl = parseMcpServerLoginCallback(input);
    const session = await this.located(projectId, provider, loginId);
    if (!session || session.phase.kind !== 'pending' || this.state(session) !== 'pending') throw new RunnerError('mcp_login_inactive');
    if (session.delivering) throw new RunnerError('busy');
    session.delivering = true;
    const delivery = session.phase.process.submitCallback(callbackUrl).then(accepted => accepted, () => undefined);
    this.deliveries.add(delivery);
    const accepted = await delivery.finally(() => {
      this.deliveries.delete(delivery);
      session.delivering = false;
    });
    if (accepted === undefined || this.cancellation.signal.aborted) throw new RunnerError('storage_unavailable');
    if (session.controller.signal.aborted) throw new RunnerError('mcp_login_inactive');
    if (!accepted) throw new RunnerError('mcp_callback_rejected');
    return CHANGED;
  }

  async cancelLogin(projectId: string, provider: McpServersProvider, loginId: string): Promise<McpServerChanged> {
    const session = await this.located(projectId, provider, loginId);
    if (!session) return CHANGED;
    this.forget(session);
    session.controller.abort();
    await session.settled;
    return CHANGED;
  }

  async close(): Promise<void> {
    this.cancellation.abort();
    this.active?.controller.abort();
    for (const session of this.sessions.values()) session.controller.abort();
    await Promise.allSettled([...this.changes, ...this.settling, ...this.deliveries]);
    for (const session of [...this.sessions.values()]) this.forget(session);
  }

  private assertOpen(disconnected?: AbortSignal): void {
    if (this.cancellation.signal.aborted || disconnected?.aborted) throw new RunnerError('storage_unavailable');
  }

  private async apply(project: RegisteredProject, provider: McpServersProvider, change: McpServerChange, signal: AbortSignal): Promise<void> {
    const workdir = await mcpServersCheckout(this.workspaces, project, signal, this.policy.checkoutMs);
    signal.throwIfAborted();
    await this.manager.change(provider, change, workdir, signal);
  }

  private async located(projectId: string, provider: McpServersProvider, loginId: string): Promise<LoginSession | undefined> {
    this.assertOpen();
    await mcpServersProject(this.projects, projectId);
    const session = isMcpServerLoginId(loginId) ? this.sessions.get(loginId) : undefined;
    if (!session) return undefined;
    if (session.projectId !== projectId || session.provider !== provider) throw new RunnerError('mcp_login_inactive');
    return session;
  }

  private state(session: LoginSession): McpServerLoginState {
    switch (session.phase.kind) {
      case 'starting': return 'pending';
      case 'pending': return session.controller.signal.aborted ? 'failed' : session.phase.process.state();
      case 'finished': return session.phase.state;
    }
  }

  private async begin(session: LoginSession, project: RegisteredProject, request: McpServerLoginRequest): Promise<McpServerLoginStep> {
    const signal = session.controller.signal;
    const previous = this.active;
    this.active = session;
    this.settling.add(session.settled);
    void session.settled.then(() => this.settling.delete(session.settled));
    session.timer = setTimeout(() => session.controller.abort(), this.policy.loginDeadlineMs);
    try {
      previous?.controller.abort();
      await previous?.settled;
      const attempt = await this.attempt(session, project, request);
      if (attempt.kind === 'awaitingCallback') return await this.retain(session, attempt.authorizationUrl, attempt.process);
      this.release(session);
      if (attempt.kind === 'completed') return { kind: 'completed' };
      if (!isValidMcpAuthorizationUrl(attempt.authorizationUrl)) throw new RunnerError('storage_unavailable');
      return { kind: 'finishInBrowser', authorizationUrl: attempt.authorizationUrl };
    } catch (error) {
      const replaced = this.active !== session && !this.cancellation.signal.aborted;
      this.release(session);
      throw replaced && signal.aborted ? new RunnerError('mcp_login_inactive') : error;
    }
  }

  private async attempt(session: LoginSession, project: RegisteredProject, request: McpServerLoginRequest): Promise<McpServerLoginAttempt> {
    const signal = session.controller.signal;
    signal.throwIfAborted();
    const workdir = await mcpServersCheckout(this.workspaces, project, signal, this.policy.checkoutMs);
    signal.throwIfAborted();
    return this.manager.login(session.provider, request, workdir, signal);
  }

  private async retain(session: LoginSession, authorizationUrl: string, process: McpServerLoginProcess): Promise<McpServerLoginStep> {
    const finished = process.finished.then(ignore, ignore);
    if (session.controller.signal.aborted || !isValidMcpAuthorizationUrl(authorizationUrl)) {
      session.controller.abort();
      await finished;
      throw new RunnerError('storage_unavailable');
    }
    session.phase = { kind: 'pending', process };
    this.sessions.set(session.loginId, session);
    void finished.then(() => this.finish(session, process));
    return { kind: 'awaitingCallback', loginId: session.loginId, authorizationUrl, delivery: 'paste' };
  }

  private finish(session: LoginSession, process: McpServerLoginProcess): void {
    const state = !session.controller.signal.aborted && process.state() === 'succeeded' ? 'succeeded' : 'failed';
    session.phase = { kind: 'finished', state };
    this.release(session);
    if (this.sessions.get(session.loginId) !== session || this.cancellation.signal.aborted) return;
    session.timer = setTimeout(() => this.forget(session), this.policy.loginRetentionMs);
    this.evict();
  }

  private release(session: LoginSession): void {
    if (this.active === session) this.active = undefined;
    session.settle();
  }

  private forget(session: LoginSession): void {
    if (this.sessions.get(session.loginId) === session) this.sessions.delete(session.loginId);
    if (session.phase.kind === 'finished') clearTimeout(session.timer);
  }

  private evict(): void {
    for (const session of this.sessions.values()) {
      if (this.sessions.size <= this.policy.retainedLogins) return;
      if (session.phase.kind === 'finished') this.forget(session);
    }
  }
}
