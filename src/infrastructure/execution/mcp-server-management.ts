import { request as httpRequest } from 'node:http';
import type { McpServerLoginAttempt, McpServerManager } from '../../application/mcp-server-management-service.js';
import type { McpServersWorkdir } from '../../application/mcp-servers-service.js';
import { RunnerError, type ErrorCode } from '../../domain/contracts.js';
import {
  mcpLoopbackCallbackPath, mcpLoopbackRedirect, type McpServerChange, type McpServerLoginRequest, type McpServerLoginState,
} from '../../domain/mcp-server-management.js';
import {
  claudeMcpAddPlan, claudeMcpRemovePlan, codexMcpLogoutPlan, codexMcpRemovePlan, type McpCliOutcome, type McpCliPlan,
} from '../../domain/mcp-server-management-cli.js';
import {
  ClaudeMcpLogin, ClaudeMcpSignOut, CodexMcpAdd, CodexMcpLogin, MCP_MANAGEMENT_TIMING, type McpChangeStep, type McpLoginProgress,
  type McpManagementFailure, type McpManagementTiming,
} from '../../domain/mcp-server-management-protocol.js';
import type { McpServersProvider } from '../../domain/mcp-servers.js';
import { CLAUDE_MCP_INITIALIZE_REQUEST, CODEX_MCP_INITIALIZE_REQUEST, type McpProbeRequest } from '../../domain/mcp-servers-probe.js';
import { runUsageProcess, type UsageProcessLaunch, type UsageProcessOptions } from './account-usage-process.js';
import { providerEnvironment } from './cli-executor.js';
import { executable } from './command-catalog.js';
import { MCP_PROVIDER_SESSIONS, MCP_SERVERS_PROBE_BYTES } from './mcp-servers.js';
import { runProcess } from './process-runner.js';

export const MCP_SERVER_CHANGE_TIMEOUT_MS = 20_000;
export const MCP_SERVER_LOGIN_DEADLINE_MS = 300_000;
export const MCP_SERVER_CALLBACK_TIMEOUT_MS = 10_000;
export const MCP_SERVER_MANAGEMENT_BYTES = Object.freeze({
  cliOutputBytes: 65_536, callbackResponseBytes: 65_536,
  loginOutputBytes: Object.freeze({ claude: 512 * 1024 * 1024, codex: 16 * 1024 * 1024 }),
});
export type McpServerManagementCliOptions = UsageProcessOptions & Readonly<{
  timing?: Partial<McpManagementTiming>; loginDeadlineMs?: number; callbackTimeoutMs?: number;
}>;

const TIMEOUT_GRACE_MS = 1_000;
const MAX_TICK_MS = 50;
const SIGN_IN_AGAIN_LOGOUT_MS = 8_000;
const INITIAL_REQUESTS = Object.freeze({ claude: CLAUDE_MCP_INITIALIZE_REQUEST, codex: CODEX_MCP_INITIALIZE_REQUEST });

type Write = (value: unknown) => void;
type Deliver = (callbackUrl: string) => Promise<boolean>;
type ChangeProtocol = Readonly<{ observe(line: string, now: number): void; step(now: number): McpChangeStep }>;
type LoginProtocol = Readonly<{ observe(line: string, now: number): void; step(now: number): readonly McpProbeRequest[]; progress(): McpLoginProgress }>;
type Session = Readonly<{ program: string; args: readonly string[]; initialInput: string; launch: UsageProcessLaunch; timeoutMs: number }>;
type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

const ignore = () => undefined;

function deferred(): Deferred {
  let resolve: () => void = ignore;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function line(request: unknown): string {
  return JSON.stringify(request) + '\n';
}
function unavailable(): Error {
  return new Error('mcp_server_management_unavailable');
}
function failure(reason: McpManagementFailure, unsupported: ErrorCode): Error {
  switch (reason) {
    case 'exists': return new RunnerError('mcp_server_exists');
    case 'notFound': return new RunnerError('mcp_server_not_found');
    case 'unsupported': return new RunnerError(unsupported);
    case 'handshake': case 'request': case 'payload': case 'timeout': return unavailable();
  }
}
function changed(outcome: McpCliOutcome): void {
  switch (outcome) {
    case 'ok': return;
    case 'exists': throw new RunnerError('mcp_server_exists');
    case 'notFound': throw new RunnerError('mcp_server_not_found');
    case 'unsupported': throw new RunnerError('mcp_change_unsupported');
    case 'failed': throw unavailable();
  }
}
function started(progress: McpLoginProgress): McpServerLoginAttempt {
  switch (progress.kind) {
    case 'completed': return { kind: 'completed' };
    case 'finishInBrowser': return { kind: 'finishInBrowser', authorizationUrl: progress.authorizationUrl };
    case 'failed': throw failure(progress.failure, 'mcp_login_unsupported');
    case 'starting': case 'awaitingCallback': case 'succeeded': throw unavailable();
  }
}

function deliverLoopbackCallback(port: number, path: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { connection: 'close' } });
    const settle = (accepted: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', refuse);
      resolve(accepted);
      outgoing.destroy();
    };
    const refuse = () => settle(false);
    const timer = setTimeout(refuse, timeoutMs);
    signal.addEventListener('abort', refuse, { once: true });
    outgoing.on('error', refuse);
    outgoing.once('response', response => {
      const status = response.statusCode ?? 0;
      let bytes = 0;
      response.on('error', refuse);
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MCP_SERVER_MANAGEMENT_BYTES.callbackResponseBytes) refuse();
      });
      response.once('end', () => settle(response.complete && status >= 200 && status < 300));
      response.once('close', refuse);
    });
    outgoing.end();
  });
}

class LoginConversation {
  readonly finished: Promise<void>;
  private readonly start = deferred();
  private closed = false;
  private watcher: () => void = ignore;

  constructor(private readonly machine: LoginProtocol, session: Session, signal: AbortSignal) {
    const advance = (write: Write): boolean => {
      machine.step(performance.now()).forEach(request => write(request));
      const progress = machine.progress();
      if (progress.kind !== 'starting') this.start.resolve();
      this.watcher();
      return progress.kind !== 'starting' && progress.kind !== 'awaitingCallback';
    };
    this.finished = runUsageProcess(session.program, session.args, {
      initialInput: session.initialInput,
      tickMs: MAX_TICK_MS,
      onTick: advance,
      onLine: (text, write) => {
        machine.observe(text, performance.now());
        return advance(write);
      },
    }, signal, session.timeoutMs, session.launch).then(ignore, ignore).then(() => {
      this.closed = true;
      this.start.resolve();
      this.watcher();
    });
  }

  async attempt(deliver: Deliver): Promise<McpServerLoginAttempt> {
    await this.start.promise;
    const progress = this.machine.progress();
    if (progress.kind !== 'awaitingCallback' || this.closed) {
      await this.finished;
      return started(this.machine.progress());
    }
    return { kind: 'awaitingCallback', authorizationUrl: progress.authorizationUrl, process: {
      finished: this.finished,
      state: () => this.state(),
      submitCallback: callbackUrl => this.state() === 'pending' ? deliver(callbackUrl) : Promise.resolve(false),
    } };
  }

  async until(settled: () => boolean, timeoutMs: number): Promise<void> {
    const answered = deferred();
    const timer = setTimeout(answered.resolve, timeoutMs);
    this.watcher = () => { if (this.closed || settled()) answered.resolve(); };
    try { await answered.promise; }
    finally {
      clearTimeout(timer);
      this.watcher = ignore;
    }
  }

  private state(): McpServerLoginState {
    const progress = this.machine.progress();
    if (progress.kind === 'succeeded') return 'succeeded';
    if (progress.kind === 'awaitingCallback' && !this.closed) return 'pending';
    return 'failed';
  }
}

export class CliMcpServerManager implements McpServerManager {
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly timeoutMs: number;
  private readonly loginDeadlineMs: number;
  private readonly callbackTimeoutMs: number;
  private readonly timing: McpManagementTiming;

  constructor(options: McpServerManagementCliOptions = {}) {
    this.claudeExecutable = executable(options.claudeExecutable, 'claude');
    this.codexExecutable = executable(options.codexExecutable, 'codex');
    this.timeoutMs = options.timeoutMs ?? MCP_SERVER_CHANGE_TIMEOUT_MS;
    this.loginDeadlineMs = options.loginDeadlineMs ?? MCP_SERVER_LOGIN_DEADLINE_MS;
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? MCP_SERVER_CALLBACK_TIMEOUT_MS;
    this.timing = { ...MCP_MANAGEMENT_TIMING, ...options.timing };
    if ([this.timeoutMs, this.loginDeadlineMs, this.callbackTimeoutMs, ...Object.values(this.timing)].some(value => !Number.isFinite(value) || value < 1))
      throw new Error('invalid_mcp_server_management_timing');
  }

  change(provider: McpServersProvider, change: McpServerChange, workdir: McpServersWorkdir, signal: AbortSignal): Promise<void> {
    switch (provider) {
      case 'claude': return this.claudeChange(change, workdir, signal);
      case 'codex': return this.codexChange(change, workdir, signal);
    }
  }

  login(provider: McpServersProvider, request: McpServerLoginRequest, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServerLoginAttempt> {
    const startedAt = performance.now();
    switch (provider) {
      case 'claude': return this.claudeLogin(request, startedAt, workdir, signal);
      case 'codex': return this.codexLogin(request, startedAt, workdir, signal);
    }
  }

  private program(provider: McpServersProvider): string {
    switch (provider) {
      case 'claude': return this.claudeExecutable;
      case 'codex': return this.codexExecutable;
    }
  }

  private async claudeChange(change: McpServerChange, workdir: McpServersWorkdir, signal: AbortSignal): Promise<void> {
    switch (change.kind) {
      case 'add': return changed(await this.cli('claude', claudeMcpAddPlan(change), workdir, signal, this.timeoutMs));
      case 'remove': return changed(await this.cli('claude', claudeMcpRemovePlan(change), workdir, signal, this.timeoutMs));
      case 'signOut': return this.converse('claude', new ClaudeMcpSignOut(change.name, this.timing), workdir, signal);
    }
  }

  private async codexChange(change: McpServerChange, workdir: McpServersWorkdir, signal: AbortSignal): Promise<void> {
    switch (change.kind) {
      case 'add': return this.converse('codex', new CodexMcpAdd(change, workdir.cwd), workdir, signal);
      case 'remove': return changed(await this.cli('codex', codexMcpRemovePlan(change.name), workdir, signal, this.timeoutMs));
      case 'signOut': return changed(await this.cli('codex', codexMcpLogoutPlan(change.name), workdir, signal, this.timeoutMs));
    }
  }

  private async cli(provider: McpServersProvider, plan: McpCliPlan, workdir: McpServersWorkdir, signal: AbortSignal, timeoutMs: number): Promise<McpCliOutcome> {
    const output = { stdout: '', stderr: '' };
    const result = await runProcess({ executable: this.program(provider), args: plan.args, cwd: workdir.cwd, cwdIdentity: workdir.identity, stdin: '',
      env: providerEnvironment(), signal, timeoutMs, outputBytes: MCP_SERVER_MANAGEMENT_BYTES.cliOutputBytes,
      onOutput: async (channel, text) => { output[channel] += text; } });
    if (result.error) return 'failed';
    return plan.outcome(result.exitCode, `${output.stdout}\n${output.stderr}`);
  }

  private session(provider: McpServersProvider, workdir: McpServersWorkdir, timeoutMs: number, outputBytes: number): Session {
    const { args, env } = MCP_PROVIDER_SESSIONS[provider];
    return { program: this.program(provider), args, initialInput: line(INITIAL_REQUESTS[provider]), timeoutMs,
      launch: { cwd: workdir.cwd, cwdIdentity: workdir.identity, env: { ...providerEnvironment(), ...env },
        lineBytes: MCP_SERVERS_PROBE_BYTES[provider].lineBytes, outputBytes, ceilingMs: timeoutMs } };
  }

  private async converse(provider: McpServersProvider, machine: ChangeProtocol, workdir: McpServersWorkdir, signal: AbortSignal): Promise<void> {
    const session = this.session(provider, workdir, this.timeoutMs, MCP_SERVERS_PROBE_BYTES[provider].outputBytes);
    const advance = (write: Write): boolean => {
      const step = machine.step(performance.now());
      if (step.kind === 'write') step.requests.forEach(request => write(request));
      return step.kind === 'done' || step.kind === 'failed';
    };
    await runUsageProcess(session.program, session.args, {
      initialInput: session.initialInput,
      tickMs: MAX_TICK_MS,
      onTick: advance,
      onLine: (text, write) => {
        machine.observe(text, performance.now());
        return advance(write);
      },
    }, signal, session.timeoutMs, session.launch);
    const outcome = machine.step(performance.now());
    if (outcome.kind === 'failed') throw failure(outcome.failure, 'mcp_change_unsupported');
    if (outcome.kind !== 'done') throw unavailable();
  }

  private conversation(provider: McpServersProvider, machine: LoginProtocol, workdir: McpServersWorkdir, signal: AbortSignal): LoginConversation {
    const hardTimeoutMs = this.loginDeadlineMs + TIMEOUT_GRACE_MS;
    return new LoginConversation(machine, this.session(provider, workdir, hardTimeoutMs, MCP_SERVER_MANAGEMENT_BYTES.loginOutputBytes[provider]), signal);
  }

  private claudeLogin(request: McpServerLoginRequest, startedAt: number, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServerLoginAttempt> {
    const machine = new ClaudeMcpLogin(request.name, request.mode, startedAt, this.timing);
    const conversation = this.conversation('claude', machine, workdir, signal);
    return conversation.attempt(async callbackUrl => {
      if (!machine.submitCallback(callbackUrl)) return false;
      await conversation.until(() => machine.callback() !== 'pending', this.callbackTimeoutMs);
      return machine.callback() === 'accepted';
    });
  }

  private async codexLogin(request: McpServerLoginRequest, startedAt: number, workdir: McpServersWorkdir, signal: AbortSignal): Promise<McpServerLoginAttempt> {
    if (request.mode === 'signInAgain')
      await this.cli('codex', codexMcpLogoutPlan(request.name), workdir, signal, Math.min(this.timeoutMs, SIGN_IN_AGAIN_LOGOUT_MS));
    signal.throwIfAborted();
    const machine = new CodexMcpLogin(request.name, startedAt, this.timing);
    return this.conversation('codex', machine, workdir, signal).attempt(async callbackUrl => {
      const progress = machine.progress();
      const redirect = progress.kind === 'awaitingCallback' ? mcpLoopbackRedirect(progress.authorizationUrl) : null;
      const path = redirect ? mcpLoopbackCallbackPath(redirect, callbackUrl) : null;
      if (!redirect || path === null) return false;
      return deliverLoopbackCallback(redirect.port, path, this.callbackTimeoutMs, signal);
    });
  }
}
