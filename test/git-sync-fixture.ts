import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Task } from '../src/domain/contracts.js';
import type { ExecutionRequest, ExecutionResult } from '../src/domain/execution.js';
import type { GitOperation } from '../src/domain/git-sync.js';
import { openRunnerServices, type RunnerExecutionOptions } from '../src/runtime.js';

const exec = promisify(execFile);
export const ORIGIN_URL = 'git@example.invalid:owner/project.git';

// Only the external SSH transport is substituted; Git, SQLite, orchestration and worktrees are real.
const SSH_STUB = `#!/bin/sh
for last in "$@"; do :; done
echo "$last" >> "$CODEVO_TEST_SSH_DIR/log"
mode=$(cat "$CODEVO_TEST_SSH_DIR/mode" 2>/dev/null)
case "$mode" in
  fail) echo "ssh: connect to host example.invalid port 22: Connection refused" >&2; exit 255 ;;
  auth) echo "git@example.invalid: Permission denied (publickey)." >&2; exit 255 ;;
  sleep) echo $$ > "$CODEVO_TEST_SSH_DIR/pid"; exec sleep 30 ;;
  block) touch "$CODEVO_TEST_SSH_DIR/blocked"; while [ ! -e "$CODEVO_TEST_SSH_DIR/release" ]; do sleep 0.05; done ;;
esac
case "$last" in
  git-receive-pack*) exec git-receive-pack "$(cat "$CODEVO_TEST_SSH_DIR/repository")" ;;
  *) exec git-upload-pack "$(cat "$CODEVO_TEST_SSH_DIR/repository")" ;;
esac
`;

export type ProviderHook = (request: ExecutionRequest) => Promise<ExecutionResult>;

export async function waitFor<T>(read: () => Promise<T | undefined>, message: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(message);
}

export function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

export async function gitSyncFixture(t: TestContext, options: Partial<RunnerExecutionOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-git-sync-'));
  const remote = join(root, 'remote.git');
  const peer = join(root, 'peer');
  const source = join(root, 'source');
  const ssh = join(root, 'ssh');
  const bin = join(root, 'bin');
  await mkdir(ssh);
  await mkdir(bin);
  const run = async (cwd: string, ...args: string[]) =>
    (await exec('git', ['-c', 'user.name=Peer', '-c', 'user.email=peer@example.invalid', ...args], { cwd })).stdout.trim();
  await exec('git', ['init', '--bare', '-b', 'main', remote]);
  await exec('git', ['clone', '--quiet', remote, peer]);
  await writeFile(join(peer, 'file.txt'), 'main\n');
  await run(peer, 'add', '.');
  await run(peer, 'commit', '-m', 'Initial');
  await run(peer, 'push', '--quiet', 'origin', 'HEAD:main');
  await run(peer, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(join(peer, 'file.txt'), 'feature\n');
  await run(peer, 'commit', '-am', 'Feature');
  await run(peer, 'push', '--quiet', 'origin', 'feature');
  await run(peer, 'checkout', '--quiet', 'main');
  await exec('git', ['clone', '--quiet', remote, source]);
  await exec('git', ['-C', source, 'remote', 'set-url', 'origin', ORIGIN_URL]);
  await writeFile(join(ssh, 'repository'), remote);
  await writeFile(join(bin, 'ssh'), SSH_STUB, { mode: 0o700 });

  const previousPath = process.env.PATH;
  const previousDir = process.env.CODEVO_TEST_SSH_DIR;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.CODEVO_TEST_SSH_DIR = ssh;
  let hook: ProviderHook = async () => ({ exitCode: 0 });
  let calls = 0;
  const services = await openRunnerServices(join(root, 'data'), randomUUID(), {
    projects: [{ id: 'project', name: 'Project', path: source }],
    providers: [{ provider: 'claude', supportsAttachments: false, execute: request => { calls++; return hook(request); } }],
    ...options,
  });
  t.after(async () => {
    await writeFile(join(ssh, 'release'), '');
    await services.close();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousDir === undefined) delete process.env.CODEVO_TEST_SSH_DIR; else process.env.CODEVO_TEST_SSH_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  const sync = services.gitSync!;
  const execution = services.execution!;
  const create = async (isolation?: 'in-place' | 'worktree') => (await services.tasks.create({
    idempotencyKey: randomUUID(), provider: 'claude', ...(isolation ? { isolation } : {}), parts: [{ type: 'text', text: 'Work' }],
  })).task;
  const settled = (id: string) => waitFor(async () => {
    const task = await services.tasks.get(id);
    return ['queued', 'running'].includes(task.status) ? undefined : task;
  }, 'Task did not settle');
  const operation = (id: string) => waitFor(async () => {
    const current = await sync.operation(id);
    return current.status === 'running' ? undefined : current;
  }, 'Git operation did not settle');
  const failure = async (task: Task) => {
    const events = await services.tasks.events(task.id, 0);
    return events.items.find(event => event.type === 'task.failed')?.error;
  };
  return {
    root, remote, peer, source, ssh, services, sync, execution, create, settled, failure, run,
    operation: operation as (id: string) => Promise<GitOperation>,
    calls: () => calls,
    provider(next: ProviderHook) { hook = next; },
    mode: (value: '' | 'fail' | 'auth' | 'sleep' | 'block') => writeFile(join(ssh, 'mode'), value),
    remoteSha: (ref: string) => exec('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref]).then(result => result.stdout.trim(), () => null),
    sshCalls: () => readFile(join(ssh, 'log'), 'utf8').then(text => text.split('\n').filter(Boolean).length, () => 0),
  };
}
