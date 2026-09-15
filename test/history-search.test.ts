import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { parseHistorySearch } from '../src/domain/history-search.js';

test('retained history search traverses unloaded tasks and empty pages without duplicate matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-search-'));
  const repo = await openSqliteRepository(dir, randomUUID());
  try {
    const ids: string[] = [];
    for (let i = 0; i < 62; i++) {
      ids.push((await repo.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: i === 0 || i === 61 ? 'İ'.repeat(400) + 'Old needle history' : 'other' }] })).task.id);
    }
    const found: string[] = []; let after = 0; let pages = 0;
    do {
      const page = await repo.searchHistory({ q: 'NEEDLE', after });
      assert.equal(page.scope, 'retained_runner_history'); assert.equal(page.incomplete, false);
      assert.ok(page.items.every(item => item.snippet.includes('needle')));
      found.push(...page.items.map(item => item.taskId)); pages++;
      if (page.nextCursor === null) break;
      assert.ok(page.nextCursor > after); after = page.nextCursor;
    } while (pages < 20);
    assert.deepEqual(found, [ids[0], ids[61]]); assert.equal(pages, 7);
    assert.equal((await repo.searchHistory({ q: "%' OR 1=1 --", after: 0 })).items.length, 0);
  } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test('assistant search reconstructs split records and excludes tools, stderr and foreign projects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-search-'));
  const repo = await openSqliteRepository(dir, randomUUID());
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const { task } = await repo.createTask({ idempotencyKey: randomUUID(), provider, parts: [{ type: 'text', text: 'prompt' }] });
      await repo.queueTask(task.id, 'project-a'); await repo.claimNextTask();
      const line = JSON.stringify(provider === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text: 'answer needle 🔍\u0000' } } : { type: 'assistant', message: { content: [{ type: 'text', text: 'answer needle 🔍\u0000' }] } });
      await repo.appendTaskOutput(task.id, 'stdout', line.slice(0, 18));
      await repo.appendTaskOutput(task.id, 'stdout', line.slice(18) + '\n');
      await repo.appendTaskOutput(task.id, 'stderr', 'secretneedle');
      await repo.appendTaskOutput(task.id, 'stdout', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'secretneedle' } }) + '\n');
      await repo.finishTask(task.id, { exitCode: 0 });
    }
    const page = await repo.searchHistory({ q: 'needle', after: 0, projectId: 'project-a' });
    assert.equal(page.items.length, 2); assert.equal(page.incomplete, false);
    assert.ok(page.items.every(item => item.role === 'assistant' && item.eventSequence !== null && item.snippet.includes('🔍') && !item.snippet.includes('\u0000')));
    assert.equal((await repo.searchHistory({ q: 'secretneedle', after: 0 })).items.length, 0);
    assert.equal((await repo.searchHistory({ q: 'needle', after: 0, projectId: 'project-b' })).items.length, 0);
    const { task } = await repo.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'prompt' }] });
    await repo.queueTask(task.id, 'project-a'); await repo.claimNextTask();
    await repo.appendTaskOutput(task.id, 'stdout', '{bad JSON\n');
    assert.equal((await repo.searchHistory({ q: 'needle', after: 0 })).incomplete, true);
  } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test('search input is closed, literal and bounded', () => {
  for (const input of [{ q: 'a', after: 0 }, { q: 'ok', after: -1 }, { q: 'ok', after: 0, extra: true }, { q: 'a'.repeat(257), after: 0 }, { q: 'ok', after: 0, projectId: '' }, { q: 'ok', after: 0, projectId: 'a\u0000b' }]) assert.throws(() => parseHistorySearch(input), { code: 'invalid_input' });
  assert.deepEqual(parseHistorySearch({ q: ' literal%_ ', after: 0 }), { q: 'literal%_', after: 0 });
});

test('history HTTP route enforces authentication, pinned identity and closed query', async t => {
  const { createRunnerApplication } = await import('../src/server.js');
  const { openRunnerServices } = await import('../src/runtime.js');
  const dir = await mkdtemp(join(tmpdir(), 'runner-search-http-'));
  const runnerId = randomUUID(); const services = await openRunnerServices(dir, runnerId);
  const app = await createRunnerApplication({ runnerId, name: 'search', protocolVersion: 1, capabilities: { taskExecution: false, eventReplay: true } }, header => header === 'Bearer search-test', services);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}/v1/history/search`;
  const headers = { authorization: 'Bearer search-test', 'x-codevo-runner-id': runnerId };
  assert.equal((await fetch(`${url}?q=hello`)).status, 401);
  assert.equal((await fetch(`${url}?q=hello`, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
  for (const query of ['q=hello&q=bye', 'q=hello&extra=no', 'q=hello&after=-1', 'q=hello&after=1.2', 'q=a', 'q=hello&after=9007199254740992']) assert.equal((await fetch(`${url}?${query}`, { headers })).status, 400, query);
  const response = await fetch(`${url}?q=hello`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], nextCursor: null, scope: 'retained_runner_history', incomplete: false });
});
