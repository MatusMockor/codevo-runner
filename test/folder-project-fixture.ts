import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Task } from '../src/domain/contracts.js';
import type { ExecutionRequest, ExecutionResult, RegisteredProject } from '../src/domain/execution.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
import { claudeScript, shellFixture, writeJson } from './mcp-servers-fixture.js';

export const FOLDER_PROJECTS = 'folderProjects';
export const NOT_REPOSITORY = { error: 'git_not_repository' };
export type FolderProvider = (request: ExecutionRequest) => Promise<ExecutionResult>;
export type FolderRunner = Awaited<ReturnType<Awaited<ReturnType<typeof folderProjectSpace>>['open']>>;

const authorization = 'Bearer folder-project-test';
const CATALOG_CLI = `
let input = '';
process.stdin.setEncoding('utf8').on('data', chunk => { input += chunk; }).on('end', () => {
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(input).request_id,
    response: { commands: [{ name: 'folder-command', description: process.cwd(), argumentHint: '', builtin: false }] } } }));
});`;

export async function folderProjectSpace(t: TestContext, configure: (root: string) => Promise<readonly RegisteredProject[]> = async () => []) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'codevo-folder-project-')));
  const closers: (() => Promise<unknown> | void)[] = [() => rm(temp, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
  });
  const projectsRoot = join(temp, 'Developer');
  const dataDir = join(projectsRoot, '.agent', 'codevo-runner');
  const bin = join(temp, 'bin'), cli = join(temp, 'cli'), gitLog = join(temp, 'git-launches');
  for (const directory of [dataDir, bin, cli]) await mkdir(directory, { recursive: true });
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> "${gitLog}"\nexec "${git}" "$@"\n`, { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  closers.push(() => { process.env.PATH = path; });
  const catalog = join(cli, 'catalog.cjs');
  await writeFile(catalog, `#!${process.execPath}\n${CATALOG_CLI}`);
  await chmod(catalog, 0o700);
  await writeJson(cli, 'servers.json', { mcpServers: [{ name: 'folder-tools', status: 'connected', scope: 'user', tools: [{ name: 'first' }], config: { type: 'stdio', command: 'tool' } }] });
  const servers = await shellFixture(cli, 'claude', claudeScript(cli));
  const projects = await configure(projectsRoot);
  const runnerId = randomUUID();
  let provider: FolderProvider = async request => ({ exitCode: 0, sessionId: request.resumeSessionId ?? randomUUID() });

  const folder = async (...segments: string[]) => {
    const directory = join(projectsRoot, ...segments);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'notes.txt'), 'plain folder\n');
    return directory;
  };
  const repository = async (...segments: string[]) => {
    const directory = join(projectsRoot, ...segments);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'tracked.txt'), 'tracked\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'Initial']])
      execFileSync(git, args, { cwd: directory, stdio: 'ignore' });
    return directory;
  };
  const gitLaunches = async () => (await readFile(gitLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);

  const open = async (configured: readonly RegisteredProject[] = projects) => {
    const services = await openRunnerServices(dataDir, runnerId, {
      projects: configured, projectsRoot,
      providers: [{ provider: 'claude', supportsAttachments: false, execute: request => provider(request) }],
      commandCatalogCli: { claudeExecutable: catalog },
      mcpServersCli: { claudeExecutable: servers, timing: { pollMs: 10, stableMs: 100, settleMs: 5_000 } },
    });
    const app = await createRunnerApplication({ runnerId, name: 'Folder project test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await app.close();
    };
    closers.push(close);
    await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const owner = { authorization, 'x-codevo-runner-id': runnerId };
    const announced = { ...owner, 'x-codevo-client-capabilities': FOLDER_PROJECTS };
    const get = (route: string, headers: Record<string, string> = owner) => fetch(`${url}${route}`, { headers });
    const post = (route: string, value: unknown, headers: Record<string, string> = owner) => fetch(`${url}${route}`, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const register = async (directory: string, name: string, headers: Record<string, string> = announced) => {
      const reply = await post('/v1/projects/register', { path: directory, name }, headers);
      return { status: reply.status, body: await reply.json() as unknown };
    };
    const registerFolder = async (name: string) => {
      const directory = await folder(name);
      assert.deepEqual(await register(directory, name), { status: 200, body: { status: 'registered', project: { id: name, name }, created: true } });
      return directory;
    };
    const draft = async (isolation?: 'in-place' | 'worktree') => {
      const reply = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider: 'claude', ...(isolation ? { isolation } : {}), parts: [{ type: 'text', text: 'Work' }] });
      assert.equal(reply.status, 201);
      return (await reply.json() as { task: Task }).task;
    };
    const task = async (id: string) => await (await get(`/v1/tasks/${id}`)).json() as Task;
    const settled = async (id: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const current = await task(id);
        if (!['queued', 'running'].includes(current.status)) return current;
        await delay(20);
      }
      return assert.fail(`Task ${id} did not settle`);
    };
    const run = async (projectId: string) => {
      const created = await draft('in-place');
      const started = await post(`/v1/tasks/${created.id}/start`, { projectId });
      assert.equal(started.status, 202);
      return settled(created.id);
    };
    const next = async (taskId: string) => {
      const reply = await post(`/v1/tasks/${taskId}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Continue' }] });
      assert.equal(reply.status, 202);
      return settled((await reply.json() as { task: Task }).task.id);
    };
    const failure = async (id: string) => {
      const events = await (await get(`/v1/tasks/${id}/events`)).json() as { items: { type: string; error?: string }[] };
      return events.items.find(event => event.type === 'task.failed')?.error;
    };
    return { services, url, owner, announced, get, post, register, registerFolder, draft, task, settled, run, next, failure, close };
  };

  return { temp, projectsRoot, dataDir, runnerId, git, folder, repository, gitLaunches, open, closers,
    provider(next: FolderProvider) { provider = next; } };
}

export async function folderProjectRunner(t: TestContext, configure?: (root: string) => Promise<readonly RegisteredProject[]>) {
  const space = await folderProjectSpace(t, configure);
  return { ...space, ...await space.open() };
}
