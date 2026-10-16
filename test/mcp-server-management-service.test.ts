import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  MCP_SERVER_MANAGEMENT_POLICY, McpServerManagementService, type McpServerLoginAttempt, type McpServerLoginProcess, type McpServerManagementPolicy,
} from '../src/application/mcp-server-management-service.js';
import type { McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { RunnerError } from '../src/domain/contracts.js';
import type { RegisteredProject } from '../src/domain/execution.js';
import { MCP_SERVER_LOGIN_ID_PATTERN, type McpServerChange, type McpServerLoginRequest, type McpServerLoginState, type McpServerLoginStep } from '../src/domain/mcp-server-management.js';
import type { McpServersProvider } from '../src/domain/mcp-servers.js';
import { eventually } from './mcp-server-management-fixture.js';

const AUTH_URL = 'https://auth.example.com/authorize?state=SECRET';
const CALLBACK = { callbackUrl: 'http://localhost:45678/callback?code=1&state=2' };
const CHANGED = { version: 1 };
const coded = (code: string) => ({ name: 'RunnerError', code });
const unavailable = coded('storage_unavailable'), inactive = coded('mcp_login_inactive'), missing = coded('not_found'), invalid = coded('invalid_input'), busy = coded('busy');
const connected = () => new AbortController().signal;
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
const addition = (name = 'docs') => ({ change: { kind: 'add', name, scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com/mcp' } } });
const signIn = (name = 'docs') => ({ name, mode: 'signIn' });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

class FakeLogin {
  current: McpServerLoginState = 'pending';
  reaped = false;
  readonly callbacks: string[] = [];
  deliver: (callbackUrl: string) => Promise<boolean> = async () => true;
  private readonly done = deferred<void>();

  constructor(readonly index: number, readonly provider: McpServersProvider, readonly request: McpServerLoginRequest, readonly workdir: McpServersWorkdir,
    readonly signal: AbortSignal, private readonly log: string[]) {
    signal.addEventListener('abort', () => { if (!this.reaped) setTimeout(() => this.end(this.current), 15); }, { once: true });
  }

  end(state: McpServerLoginState): void {
    if (this.reaped) return;
    this.current = state;
    this.reaped = true;
    this.log.push(`reaped:${this.index}`);
    this.done.resolve();
  }

  attempt(authorizationUrl = AUTH_URL): McpServerLoginAttempt {
    const process: McpServerLoginProcess = { finished: this.done.promise, state: () => this.current,
      submitCallback: callbackUrl => { this.callbacks.push(callbackUrl); return this.deliver(callbackUrl); } };
    return { kind: 'awaitingCallback', authorizationUrl, process };
  }
}

type Change = (provider: McpServersProvider, change: McpServerChange, workdir: McpServersWorkdir, signal: AbortSignal) => Promise<void>;
type Login = (login: FakeLogin) => Promise<McpServerLoginAttempt>;

function harness(t: TestContext, policy: Partial<McpServerManagementPolicy> = {}, ids: readonly string[] = ['alpha', 'beta']) {
  const state = { log: [] as string[], logins: [] as FakeLogin[], checkouts: 0, change: undefined as Change | undefined, login: undefined as Login | undefined };
  const projects = new Map<string, RegisteredProject>(ids.map(id => [id, { id, name: id, path: `/srv/${id}` }]));
  const service = new McpServerManagementService({
    get: id => projects.has(id) ? Promise.resolve(projects.get(id)!) : Promise.reject(new RunnerError('not_found')),
  }, {
    async checkout(project) {
      state.checkouts++;
      return { cwd: project.path, identity: { dev: 1, ino: project.path.length } };
    },
  }, {
    async change(provider, change, workdir, signal) {
      state.log.push(`change:${provider}:${change.kind}:${change.name}:${workdir.cwd}`);
      await state.change?.(provider, change, workdir, signal);
    },
    login(provider, request, workdir, signal) {
      const login = new FakeLogin(state.logins.length + 1, provider, request, workdir, signal, state.log);
      state.logins.push(login);
      state.log.push(`login:${login.index}:${provider}:${request.mode}:${request.name}:${workdir.cwd}`);
      return state.login ? state.login(login) : Promise.resolve(login.attempt());
    },
  }, { policy });
  t.after(() => service.close());
  const start = async (projectId = 'alpha', provider: McpServersProvider = 'claude') => {
    const started = await service.startLogin(projectId, provider, signIn(), connected());
    return awaited(started.step).loginId;
  };
  return { service, state, projects, start };
}
function awaited(step: McpServerLoginStep): Extract<McpServerLoginStep, { kind: 'awaitingCallback' }> {
  assert.equal(step.kind, 'awaitingCallback');
  assert.ok(step.kind === 'awaitingCallback');
  return step;
}

test('management policy allows one change at a time, a five minute login and a one minute memory of its end', () => {
  assert.deepEqual(MCP_SERVER_MANAGEMENT_POLICY, { concurrentChanges: 1, checkoutMs: 5_000, loginDeadlineMs: 300_000, loginRetentionMs: 60_000, retainedLogins: 16, deviceSyncMs: 60_000, deviceSyncSettleMs: 5_000 });
});

test('a change is validated before any lookup and applied once in the registered checkout', async t => {
  const { service, state } = harness(t);
  assert.deepEqual(await service.change('alpha', 'claude', addition()), CHANGED);
  assert.deepEqual(await service.change('beta', 'codex', { change: { kind: 'signOut', name: 'claude.ai Gmail' } }), CHANGED);
  assert.deepEqual(state.log, ['change:claude:add:docs:/srv/alpha', 'change:codex:signOut:claude.ai Gmail:/srv/beta']);
  assert.equal(state.checkouts, 2);

  for (const body of [null, {}, { change: null }, { change: { kind: 'add', name: '-docs', scope: 'user', launch: { kind: 'http', url: 'https://mcp.example.com' } } },
    { ...addition(), extra: true }, { change: { kind: 'remove', name: 'docs', scope: 'user', force: true } }])
    await assert.rejects(service.change('missing', 'claude', body), invalid, JSON.stringify(body));
  const unsupported: ReadonlyArray<readonly [McpServersProvider, unknown]> = [
    ['claude', { change: { ...addition().change, scope: 'project' } }], ['codex', { change: { ...addition().change, scope: 'local' } }],
    ['codex', { change: { ...addition().change, launch: { kind: 'sse', url: 'https://mcp.example.com/sse' } } }], ['codex', { change: { kind: 'remove', name: 'docs', scope: 'project' } }],
  ];
  for (const [provider, body] of unsupported) await assert.rejects(service.change('missing', provider, body), coded('mcp_change_unsupported'), JSON.stringify(body));
  for (const id of ['missing', '-bad', '../alpha', '', 'a'.repeat(65)]) await assert.rejects(service.change(id, 'claude', addition()), missing, id);
  assert.deepEqual([state.log.length, state.checkouts], [2, 2]);
});

test('change outcomes keep their code and every other failure is only unavailable', async t => {
  const { service, state } = harness(t);
  for (const code of ['mcp_server_exists', 'mcp_server_not_found', 'mcp_change_unsupported'] as const) {
    state.change = () => Promise.reject(new RunnerError(code));
    await assert.rejects(service.change('alpha', 'claude', addition()), coded(code));
  }
  for (const error of [new Error('secret /srv/alpha stderr'), new RunnerError('conflict'), new RunnerError('busy'), new RunnerError('not_found'), new RunnerError('invalid_input')]) {
    state.change = () => Promise.reject(error);
    await assert.rejects(service.change('alpha', 'claude', addition()), unavailable, error.message);
  }
  const failing = (error: Error) => new McpServerManagementService({ get: () => Promise.reject(error) }, { checkout: () => Promise.reject(new Error('unused')) },
    { change: () => Promise.reject(new Error('unused')), login: () => Promise.reject(new Error('unused')) });
  await assert.rejects(failing(new RunnerError('conflict')).change('alpha', 'codex', addition()), unavailable);
  await assert.rejects(failing(new RunnerError('not_found')).change('alpha', 'codex', addition()), missing);
  const conflicted = new McpServerManagementService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, { checkout: () => Promise.reject(new RunnerError('conflict')) },
    { change: async () => assert.fail('changed without a checkout'), login: async () => assert.fail('logged in without a checkout') });
  await assert.rejects(conflicted.change('alpha', 'claude', addition()), unavailable);
  await assert.rejects(conflicted.startLogin('alpha', 'claude', signIn(), connected()), unavailable);
  assert.equal(conflicted.working, false);
});

test('a second change is refused as busy while one runs, which counts as work until it settles', async t => {
  const { service, state } = harness(t);
  const gate = deferred<void>();
  state.change = () => gate.promise;
  assert.equal(service.working, false);
  const first = service.change('alpha', 'claude', addition());
  await eventually(() => state.log.length, count => count === 1, 'first change');
  assert.equal(service.working, true);
  await assert.rejects(service.change('beta', 'codex', addition()), busy);
  gate.resolve();
  assert.deepEqual(await first, CHANGED);
  assert.equal(service.working, false);
  state.change = undefined;
  assert.deepEqual(await service.change('beta', 'codex', addition()), CHANGED);
});

test('a login that needs no callback returns its step and retains nothing', async t => {
  const { service, state } = harness(t);
  const baseline = timers();
  state.login = async () => ({ kind: 'completed' });
  assert.deepEqual(await service.startLogin('alpha', 'claude', { name: 'docs', mode: 'signInAgain' }, connected()), { version: 1, step: { kind: 'completed' } });
  state.login = async () => ({ kind: 'finishInBrowser', authorizationUrl: AUTH_URL });
  assert.deepEqual(await service.startLogin('alpha', 'claude', signIn('claude.ai Gmail'), connected()), { version: 1, step: { kind: 'finishInBrowser', authorizationUrl: AUTH_URL } });
  assert.deepEqual(state.log, ['login:1:claude:signInAgain:docs:/srv/alpha', 'login:2:claude:signIn:claude.ai Gmail:/srv/alpha']);
  assert.deepEqual([service.working, timers()], [false, baseline]);
  state.login = async () => ({ kind: 'finishInBrowser', authorizationUrl: 'http://evil.example.com/authorize' });
  await assert.rejects(service.startLogin('alpha', 'claude', signIn(), connected()), unavailable);
  for (const code of ['mcp_login_unsupported', 'mcp_server_not_found'] as const) {
    state.login = () => Promise.reject(new RunnerError(code));
    await assert.rejects(service.startLogin('alpha', 'claude', signIn(), connected()), coded(code));
  }
  state.login = () => Promise.reject(new Error('provider stderr'));
  await assert.rejects(service.startLogin('alpha', 'claude', signIn(), connected()), unavailable);
  for (const body of [null, {}, { name: 'docs' }, { name: 'docs', mode: 'again' }, { name: ' docs', mode: 'signIn' }, { ...signIn(), scope: 'user' }])
    await assert.rejects(service.startLogin('missing', 'claude', body, connected()), invalid, JSON.stringify(body));
  await assert.rejects(service.startLogin('missing', 'claude', signIn(), connected()), missing);
  assert.deepEqual([service.working, timers(), state.logins.length], [false, baseline, 6]);
});

test('a callback login is pending under a paste delivery, bound to its project and provider, and counts as work', async t => {
  const { service, state } = harness(t);
  const started = await service.startLogin('alpha', 'codex', signIn(), connected());
  const step = awaited(started.step);
  assert.deepEqual(started, { version: 1, step: { kind: 'awaitingCallback', loginId: step.loginId, authorizationUrl: AUTH_URL, delivery: 'paste' } });
  assert.match(step.loginId, MCP_SERVER_LOGIN_ID_PATTERN);
  assert.equal(service.working, true);
  assert.deepEqual(await service.loginState('alpha', 'codex', step.loginId), { version: 1, state: 'pending' });
  await assert.rejects(service.loginState('beta', 'codex', step.loginId), inactive);
  await assert.rejects(service.loginState('alpha', 'claude', step.loginId), inactive);
  await assert.rejects(service.submitLoginCallback('beta', 'codex', step.loginId, CALLBACK), inactive);
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', step.loginId, CALLBACK), inactive);
  await assert.rejects(service.cancelLogin('beta', 'codex', step.loginId), inactive);
  await assert.rejects(service.cancelLogin('alpha', 'claude', step.loginId), inactive);
  for (const id of ['0b9f3c1e-7d2a-4f65-9c11-2d8f4a6b7c90', 'short', '../../etc/passwd', '', 'a'.repeat(65)]) {
    await assert.rejects(service.loginState('alpha', 'codex', id), inactive, id);
    await assert.rejects(service.submitLoginCallback('alpha', 'codex', id, CALLBACK), inactive, id);
    assert.deepEqual(await service.cancelLogin('alpha', 'codex', id), CHANGED, id);
  }
  for (const call of [() => service.loginState('missing', 'codex', step.loginId), () => service.submitLoginCallback('missing', 'codex', step.loginId, CALLBACK),
    () => service.cancelLogin('missing', 'codex', step.loginId)]) await assert.rejects(call(), missing);
  assert.deepEqual([state.logins[0]!.signal.aborted, state.logins[0]!.callbacks.length], [false, 0]);
  assert.deepEqual(await service.loginState('alpha', 'codex', step.loginId), { version: 1, state: 'pending' });
});

test('a finished login keeps its terminal state for the retention window and is then forgotten', async t => {
  const { service, state, start } = harness(t, { loginRetentionMs: 120 });
  const baseline = timers();
  const succeeded = await start();
  state.logins[0]!.current = 'succeeded';
  assert.deepEqual(await service.loginState('alpha', 'claude', succeeded), { version: 1, state: 'succeeded' });
  state.logins[0]!.end('succeeded');
  await eventually(() => service.working, working => !working, 'settlement');
  assert.deepEqual(await service.loginState('alpha', 'claude', succeeded), { version: 1, state: 'succeeded' });
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', succeeded, CALLBACK), inactive);
  await eventually(() => service.loginState('alpha', 'claude', succeeded).then(() => false, error => (error as RunnerError).code === 'mcp_login_inactive'), Boolean, 'forgetting');
  assert.equal(timers(), baseline);

  const failed = await start('beta', 'codex');
  state.logins[1]!.end('failed');
  await eventually(() => service.working, working => !working, 'settlement');
  assert.deepEqual(await service.loginState('beta', 'codex', failed), { version: 1, state: 'failed' });
  const crashed = await start();
  state.logins[2]!.end('pending');
  await eventually(() => service.working, working => !working, 'settlement');
  assert.deepEqual(await service.loginState('alpha', 'claude', crashed), { version: 1, state: 'failed' });
  assert.deepEqual(await service.loginState('beta', 'codex', failed), { version: 1, state: 'failed' });
  await eventually(() => service.loginState('alpha', 'claude', crashed).then(() => false, () => true), Boolean, 'forgetting');
  await assert.rejects(service.loginState('beta', 'codex', failed), inactive);
  assert.equal(timers(), baseline);
});

test('starting a login cancels and reaps the previous one before the next provider starts', async t => {
  const { service, state, start } = harness(t);
  const first = await start('alpha', 'claude');
  const second = await start('beta', 'codex');
  assert.deepEqual(state.log, ['login:1:claude:signIn:docs:/srv/alpha', 'reaped:1', 'login:2:codex:signIn:docs:/srv/beta']);
  assert.deepEqual([state.logins[0]!.signal.aborted, state.logins[1]!.signal.aborted], [true, false]);
  assert.deepEqual(await service.loginState('alpha', 'claude', first), { version: 1, state: 'failed' });
  assert.deepEqual(await service.loginState('beta', 'codex', second), { version: 1, state: 'pending' });
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', first, CALLBACK), inactive);

  const gate = deferred<void>();
  state.login = async login => { await gate.promise; return login.signal.aborted ? Promise.reject(new Error('aborted')) : login.attempt(); };
  const third = assert.rejects(service.startLogin('alpha', 'claude', signIn(), connected()), inactive);
  const fourth = assert.rejects(service.startLogin('alpha', 'codex', signIn(), connected()), inactive);
  const fifth = service.startLogin('beta', 'claude', signIn(), connected());
  await eventually(() => state.logins.length, count => count >= 3, 'third provider');
  gate.resolve();
  await third;
  await fourth;
  const survivor = awaited((await fifth).step).loginId;
  assert.deepEqual(await service.loginState('beta', 'codex', second), { version: 1, state: 'failed' });
  assert.deepEqual(await service.loginState('beta', 'claude', survivor), { version: 1, state: 'pending' });
  assert.equal(state.logins.filter(login => !login.signal.aborted).length, 1);
  assert.equal(state.log.indexOf('reaped:2') < state.log.findIndex(entry => entry.startsWith('login:3:')), true);
});

test('a login past its hard deadline fails at once, is reaped and later forgotten', async t => {
  const { service, state, start } = harness(t, { loginDeadlineMs: 80, loginRetentionMs: 150 });
  const baseline = timers();
  const loginId = await start();
  assert.deepEqual(await service.loginState('alpha', 'claude', loginId), { version: 1, state: 'pending' });
  await eventually(() => state.logins[0]!.signal.aborted, Boolean, 'deadline');
  assert.deepEqual(await service.loginState('alpha', 'claude', loginId), { version: 1, state: 'failed' });
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), inactive);
  await eventually(() => service.working, working => !working, 'reaping');
  assert.equal(state.logins[0]!.reaped, true);
  assert.deepEqual(await service.loginState('alpha', 'claude', loginId), { version: 1, state: 'failed' });
  await eventually(() => service.loginState('alpha', 'claude', loginId).then(() => false, () => true), Boolean, 'forgetting');
  assert.equal(timers(), baseline);

  const slow = harness(t, { loginDeadlineMs: 60 });
  slow.state.login = login => new Promise((_resolve, reject) => login.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  await assert.rejects(slow.service.startLogin('alpha', 'claude', signIn(), connected()), unavailable);
  assert.equal(slow.service.working, false);
});

test('a pasted callback is delivered once at a time to the pending login and its verdict is reported', async t => {
  const { service, state, start } = harness(t);
  const loginId = await start();
  const login = state.logins[0]!;
  assert.deepEqual(await service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), CHANGED);
  assert.deepEqual(login.callbacks, [CALLBACK.callbackUrl]);
  login.deliver = async () => false;
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), coded('mcp_callback_rejected'));
  login.deliver = () => Promise.reject(new Error('socket'));
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), unavailable);
  for (const body of [null, {}, { callbackUrl: 'https://localhost/callback?code=1' }, { callbackUrl: 'http://example.com/callback?code=1' }, { callbackUrl: 'http://localhost/callback' }, { ...CALLBACK, loginId }])
    await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, body), invalid, JSON.stringify(body));
  assert.equal(login.callbacks.length, 3);

  const gate = deferred<boolean>();
  login.deliver = () => gate.promise;
  const slow = service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK);
  await eventually(() => login.callbacks.length, count => count === 4, 'delivery');
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), busy);
  gate.resolve(true);
  assert.deepEqual(await slow, CHANGED);
  assert.equal(login.callbacks.length, 4);
  assert.deepEqual(await service.loginState('alpha', 'claude', loginId), { version: 1, state: 'pending' });
});

test('a callback delivery in flight ends with its login on cancel, replacement, shutdown and deadline', async t => {
  const baseline = timers();
  const { service, state, start } = harness(t);
  const settled: number[] = [];
  const held = (login: FakeLogin) => () => new Promise<boolean>(resolve => login.signal.addEventListener('abort', () => setTimeout(() => {
    settled.push(login.index);
    resolve(false);
  }, 40), { once: true }));
  const delivering = async (loginId: string, login: FakeLogin, expected: Readonly<{ name: string; code: string }>) => {
    login.deliver = held(login);
    const posting = assert.rejects(service.submitLoginCallback(login.workdir.cwd.slice(5), login.provider, loginId, CALLBACK), expected);
    await eventually(() => login.callbacks.length, count => count === 1, 'delivery');
    return { posting };
  };
  const first = await start();
  const cancelled = await delivering(first, state.logins[0]!, inactive);
  assert.deepEqual(await service.cancelLogin('alpha', 'claude', first), CHANGED);
  await cancelled.posting;
  assert.deepEqual(settled, [1]);

  const second = await start('beta', 'codex');
  const replaced = await delivering(second, state.logins[1]!, inactive);
  const third = await start();
  await replaced.posting;
  assert.deepEqual(settled, [1, 2]);
  assert.deepEqual(await service.loginState('beta', 'codex', second), { version: 1, state: 'failed' });

  const closing = await delivering(third, state.logins[2]!, unavailable);
  await service.close();
  assert.deepEqual(settled, [1, 2, 3]);
  await closing.posting;
  assert.deepEqual([service.working, timers()], [false, baseline]);

  const expiring = harness(t, { loginDeadlineMs: 80 });
  const fourth = await expiring.start();
  const login = expiring.state.logins[0]!;
  login.deliver = held(login);
  await assert.rejects(expiring.service.submitLoginCallback('alpha', 'claude', fourth, CALLBACK), inactive);
  assert.deepEqual([settled, login.signal.aborted], [[1, 2, 3, 1], true]);
  await eventually(() => expiring.service.working, working => !working, 'reaping');
  await expiring.service.close();
  assert.equal(timers(), baseline);
});

test('cancelling reaps the login, forgets it at once and stays idempotent', async t => {
  const { service, state, start } = harness(t);
  const baseline = timers();
  const loginId = await start();
  assert.deepEqual(await service.cancelLogin('alpha', 'claude', loginId), CHANGED);
  assert.deepEqual([state.logins[0]!.signal.aborted, state.logins[0]!.reaped, service.working], [true, true, false]);
  await assert.rejects(service.loginState('alpha', 'claude', loginId), inactive);
  await assert.rejects(service.submitLoginCallback('alpha', 'claude', loginId, CALLBACK), inactive);
  assert.deepEqual(await service.cancelLogin('alpha', 'claude', loginId), CHANGED);
  assert.equal(timers(), baseline);

  const finished = await start();
  state.logins[1]!.end('succeeded');
  await eventually(() => service.working, working => !working, 'settlement');
  assert.deepEqual(await service.cancelLogin('alpha', 'claude', finished), CHANGED);
  await assert.rejects(service.loginState('alpha', 'claude', finished), inactive);
  assert.equal(timers(), baseline);
});

test('a client that disconnects while its login starts leaves nothing behind', async t => {
  const { service, state } = harness(t);
  const gate = deferred<void>();
  state.login = async login => { await gate.promise; return login.attempt(); };
  const client = new AbortController();
  const dropped = assert.rejects(service.startLogin('alpha', 'claude', signIn(), client.signal), unavailable);
  await eventually(() => state.logins.length, count => count === 1, 'provider start');
  client.abort();
  gate.resolve();
  await dropped;
  assert.deepEqual([state.logins[0]!.signal.aborted, state.logins[0]!.reaped, service.working], [true, true, false]);
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(service.startLogin('alpha', 'claude', signIn(), gone.signal), unavailable);
  assert.equal(state.logins.length, 1);
});

test('an unusable authorization address fails the start closed and reaps the provider', async t => {
  const { service, state } = harness(t);
  for (const url of ['http://evil.example.com/authorize', 'javascript:alert(1)', `https://auth.example.com/${'a'.repeat(4096)}`, 'https://auth.example.com/a b']) {
    state.login = async login => login.attempt(url);
    await assert.rejects(service.startLogin('alpha', 'claude', signIn(), connected()), unavailable, url);
    assert.deepEqual([state.logins.at(-1)!.signal.aborted, state.logins.at(-1)!.reaped, service.working], [true, true, false], url);
  }
});

test('only a bounded number of finished logins is remembered', async t => {
  const { service, state, start } = harness(t, { retainedLogins: 2 });
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    ids.push(await start());
    state.logins[index]!.end('failed');
    await eventually(() => service.working, working => !working, 'settlement');
  }
  for (const id of ids.slice(0, 2)) await assert.rejects(service.loginState('alpha', 'claude', id), inactive);
  for (const id of ids.slice(2)) assert.deepEqual(await service.loginState('alpha', 'claude', id), { version: 1, state: 'failed' });
});

test('shutdown reaps the pending and the starting login, clears every timer and refuses further work', async () => {
  const baseline = timers();
  const service = new McpServerManagementService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, { checkout: async project => ({ cwd: project.path, identity: { dev: 1, ino: 1 } }) },
    { change: (_provider, _change, _workdir, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      login: (provider, request, workdir, signal) => {
        const login = new FakeLogin(logins.length + 1, provider, request, workdir, signal, log);
        logins.push(login);
        return logins.length === 3 ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 15), { once: true }))
          : Promise.resolve(login.attempt());
      } }, { policy: { loginRetentionMs: 60_000 } });
  const log: string[] = [];
  const logins: FakeLogin[] = [];
  const retained = awaited((await service.startLogin('alpha', 'claude', signIn(), connected())).step).loginId;
  logins[0]!.end('succeeded');
  await eventually(() => service.working, working => !working, 'settlement');
  const pending = awaited((await service.startLogin('alpha', 'codex', signIn(), connected())).step).loginId;
  const change = assert.rejects(service.change('alpha', 'claude', addition()), unavailable);
  await eventually(() => service.working, Boolean, 'change');
  await service.close();
  await change;
  assert.deepEqual([logins[1]!.signal.aborted, logins[1]!.reaped, service.working, timers()], [true, true, false, baseline]);
  for (const call of [() => service.loginState('alpha', 'claude', retained), () => service.loginState('alpha', 'codex', pending), () => service.cancelLogin('alpha', 'codex', pending),
    () => service.submitLoginCallback('alpha', 'codex', pending, CALLBACK), () => service.change('alpha', 'claude', addition()),
    () => service.startLogin('alpha', 'claude', signIn(), connected())]) await assert.rejects(call(), unavailable);
  await service.close();

  const starting = new McpServerManagementService({ get: async id => ({ id, name: id, path: `/srv/${id}` }) }, { checkout: async project => ({ cwd: project.path, identity: { dev: 1, ino: 1 } }) },
    { change: async () => undefined,
      login: (_provider, _request, _workdir, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 15), { once: true })) });
  const start = assert.rejects(starting.startLogin('alpha', 'claude', signIn(), connected()), unavailable);
  await eventually(() => starting.working, Boolean, 'start');
  await starting.close();
  await start;
  assert.deepEqual([starting.working, timers()], [false, baseline]);
});
