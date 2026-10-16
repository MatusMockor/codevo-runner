import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ProviderExecutor } from '../src/application/execution-ports.js';
import type { ExecutionRequest } from '../src/domain/execution.js';
import { mcpDeviceLaunchDigest, serializeMcpDeviceSyncLedger } from '../src/domain/mcp-device-sync.js';
import { openRunnerServices } from '../src/runtime.js';

const exec = promisify(execFile);
const digest = mcpDeviceLaunchDigest({ kind: 'stdio', command: 'npx', args: [], env: [] });

async function until(read: () => Promise<boolean>, explanation: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await read()) return; await delay(10); }
  assert.fail(`Timed out: ${explanation}`);
}

async function launchRunner(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-device-sync-launch-')));
  const source = join(root, 'source'), dataDir = join(root, 'data'), config = join(root, '.claude.json');
  await mkdir(source);
  await exec('git', ['init', '-q', source]);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial']);
  const seen: Array<Readonly<{ provider: string; servers: ExecutionRequest['preapprovedMcpServers'] }>> = [];
  const provider = (name: 'claude' | 'codex'): ProviderExecutor => ({ provider: name, supportsAttachments: false, execute: async request => {
    seen.push({ provider: name, servers: request.preapprovedMcpServers });
    return { exitCode: 0, sessionId: randomUUID() };
  } });
  const project = { id: 'project', name: 'Project', path: source };
  const services = await openRunnerServices(dataDir, randomUUID(), { projects: [project], providers: [provider('claude'), provider('codex')], claudeLocalConfigPath: config });
  t.after(async () => { await services.close(); await rm(root, { recursive: true, force: true }); });
  const run = async (name: 'claude' | 'codex') => {
    const task = (await services.tasks.create({ idempotencyKey: randomUUID(), provider: name, parts: [{ type: 'text', text: 'Work' }] })).task;
    await services.execution!.start(task.id, { projectId: project.id });
    await until(async () => !['queued', 'running'].includes((await services.tasks.get(task.id)).status), 'task settled');
    assert.equal((await services.tasks.get(task.id)).status, 'succeeded');
    return seen.at(-1)!;
  };
  const ledger = async (text: string) => {
    await mkdir(join(dataDir, 'mcp-device-sync'), { recursive: true });
    await writeFile(join(dataDir, 'mcp-device-sync', 'project.json'), text, { mode: 0o600 });
  };
  return { source: await realpath(source), config, run, ledger };
}

test('a Claude launch pre-approves exactly the managed device-sync servers still present in the server local config', async t => {
  const state = await launchRunner(t);
  assert.deepEqual(await state.run('claude'), { provider: 'claude', servers: undefined });
  await state.ledger(serializeMcpDeviceSyncLedger(new Map([['docs', digest], ['edited', digest], ['gone', digest]])));
  await writeFile(state.config, JSON.stringify({ mcpServers: { userScope: { command: 'npx' } }, projects: {
    [state.source]: { mcpServers: { docs: { command: 'npx' }, edited: { command: 'changed' }, own: { command: 'npx' } } },
  } }));
  assert.deepEqual(await state.run('claude'), { provider: 'claude', servers: ['docs'] });
  assert.deepEqual(await state.run('codex'), { provider: 'codex', servers: undefined });
  await writeFile(state.config, '{"projects":');
  assert.deepEqual(await state.run('claude'), { provider: 'claude', servers: undefined });
  await writeFile(state.config, JSON.stringify({ projects: { [state.source]: { mcpServers: { docs: { command: 'npx' } } } } }));
  await state.ledger('{"version":1,');
  assert.deepEqual(await state.run('claude'), { provider: 'claude', servers: undefined });
});
