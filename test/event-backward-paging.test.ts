import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryDatabase } from '../src/infrastructure/sqlite/database.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { createAttachmentStore } from '../src/infrastructure/files/index.js';
import { TaskService } from '../src/application/task-service.js';
import { loadAuthorization } from '../src/auth.js';
import { createRunnerApplication } from '../src/server.js';
import type { EventPage } from '../src/domain/contracts.js';

const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const, parts: [{ type: 'text' as const, text: 'paging' }] });

test('backward HTTP pages cover task history exactly once and negotiate discovery strictly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-backward-')); const runnerId = randomUUID();
  const seed = new RepositoryDatabase(directory, runnerId);
  const task = seed.createTask(input()).task; const other = seed.createTask(input()).task;
  seed.queueTask(task.id, 'project'); seed.claimNextTask();
  for (let i = 0; i < 123; i++) seed.appendTaskOutput(task.id, 'stdout', `${i}\n`);
  seed.close();
  const raw = new DatabaseSync(join(directory, 'runner.sqlite'));
  raw.prepare('UPDATE task_execution SET output_truncated_before_sequence=1,output_starts_at_line_boundary=0 WHERE task_id=?').run(task.id); raw.close();
  const repository = await openSqliteRepository(directory, runnerId);
  const token = 'backward-test-token-123456789012345678901234567890'; const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, token);
  const app = await createRunnerApplication({ runnerId, name: 'Paging', protocolVersion: 1, capabilities: { taskExecution: false, eventReplay: true } }, await loadAuthorization(tokenFile), { tasks: new TaskService(repository), attachments: await createAttachmentStore(directory, runnerId, repository), close: () => repository.close() });
  t.after(async () => { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${token}` };
  const request = (path: string) => fetch(base + path, { headers });
  const path = `/v1/tasks/${task.id}/events`;
  const all = []; let after = 0;
  for (;;) { const page = await repository.listEvents(task.id, after); all.push(...page.items); if (page.nextCursor === null) break; after = page.nextCursor; }
  const seen = []; let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = await (await request(`${path}?before=${before}`)).json() as EventPage;
    assert.equal(page.outputTruncatedBeforeSequence, 1); assert.equal(page.outputStartsAtLineBoundary, false);
    assert.ok(page.items.every(event => event.taskId === task.id && event.taskId !== other.id));
    assert.deepEqual(page.items, all.filter(event => event.sequence < before).slice(-50));
    seen.unshift(...page.items);
    if (page.nextCursor === null) break;
    assert.equal(page.nextCursor, page.items[0]!.sequence); before = page.nextCursor;
  }
  assert.deepEqual(seen, all);
  for (const before of [1, all[0]!.sequence]) { const page = await (await request(`${path}?before=${before}`)).json() as EventPage; assert.deepEqual(page.items, []); assert.equal(page.nextCursor, null); }
  for (const query of ['before=0', 'before=01', 'before=-1', 'before=+1', 'before=1.0', 'before=', 'before=9007199254740992', 'before=1&after=0', 'after=0&before=1']) {
    const response = await request(`${path}?${query}`); assert.equal(response.status, 400, query); assert.deepEqual(await response.json(), { error: 'invalid_input' });
  }
  for (const query of ['before=1&extra=1', 'extra=1', 'before=1&before=2']) assert.equal((await request(`${path}?${query}`)).status, 404);
  assert.equal((await request(`/v1/tasks/${randomUUID()}/events?before=1`)).status, 404);
  assert.equal((await fetch(base + path + '?before=1')).status, 401);
  assert.equal(await (await request(path)).text(), JSON.stringify(await repository.listEvents(task.id, 0)));
  assert.equal(await (await request(path + '?after=0')).text(), JSON.stringify(await repository.listEvents(task.id, 0)));
  const legacy = (await (await request('/v1/runner')).json()).capabilities;
  assert.equal(legacy.eventBackwardPaging, undefined);
  const modern = (await (await fetch(base + '/v1/runner', { headers: { ...headers, 'x-codevo-client-capabilities': 'speechTranscription,eventBackwardPaging' } })).json()).capabilities;
  assert.equal(modern.eventBackwardPaging, true);
  assert.equal((await (await fetch(base + '/v1/runner', { headers: { ...headers, 'x-codevo-client-capabilities': 'eventBackwardPagingOther' } })).json()).capabilities.eventBackwardPaging, undefined);
});

test('backward byte budget retains the newest events and always permits one oversized item', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-backward-budget-')); const runnerId = randomUUID();
  let db = new RepositoryDatabase(directory, runnerId);
  try {
    const task = db.createTask(input()).task; db.queueTask(task.id, 'project'); db.claimNextTask();
    for (let i = 0; i < 4; i++) db.appendTaskOutput(task.id, 'stdout', `${i}`);
    db.close(); const raw = new DatabaseSync(join(directory, 'runner.sqlite'));
    raw.prepare("UPDATE events SET data=? WHERE task_id=? AND type='task.output'").run(JSON.stringify({ channel: 'stdout', text: 'x'.repeat(1100 * 1024) }), task.id); raw.close();
    db = new RepositoryDatabase(directory, runnerId);
    const page = db.listEvents(task.id, { direction: 'before', sequence: Number.MAX_SAFE_INTEGER });
    assert.equal(page.items.length, 2); assert.equal(page.nextCursor, page.items[0]!.sequence);
    const newest = page.items[1]!.sequence; db.close();
    const huge = new DatabaseSync(join(directory, 'runner.sqlite'));
    huge.prepare('UPDATE events SET data=? WHERE sequence=?').run(JSON.stringify({ channel: 'stdout', text: 'x'.repeat(4 * 1024 * 1024) }), newest); huge.close();
    db = new RepositoryDatabase(directory, runnerId);
    assert.deepEqual(db.listEvents(task.id, { direction: 'before', sequence: newest + 1 }).items.map(event => event.sequence), [newest]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
