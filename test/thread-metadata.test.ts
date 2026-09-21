import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { parseThreadMetadataPatch } from '../src/domain/thread-metadata.js';
const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const, parts: [{ type: 'text' as const, text: 'Task' }] });

test('metadata survives restart, isolates tasks and CAS admits exactly one racing mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-metadata-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const { task } = await repository.createTask(input());
    const second = (await repository.createTask(input())).task;
    assert.equal((await repository.getThreadMetadata(task.id)).revision, 0);
    const results = await Promise.allSettled([
      repository.patchThreadMetadata(task.id, { expectedRevision: 0, title: 'Renamed', pinned: true }),
      repository.patchThreadMetadata(task.id, { expectedRevision: 0, title: 'Other' }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.equal((results[1] as PromiseRejectedResult).reason.code, 'conflict');
    assert.equal((await repository.getThreadMetadata(second.id)).revision, 0);
    await assert.rejects(repository.patchThreadMetadata(randomUUID(), { expectedRevision: 0, archived: true }), { code: 'not_found' });
    await repository.close(); repository = await openSqliteRepository(directory, runnerId);
    assert.equal((await repository.getThreadMetadata(task.id)).title, 'Renamed');
    assert.equal((await repository.listThreadMetadata('')).items.length, 1);
    await repository.queueTask(task.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(task.id, { exitCode: 0, sessionId: randomUUID() });
    const next = await repository.continueTask(task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Next' }] });
    assert.equal((await repository.getThreadMetadata(next.task.id)).taskId, task.id);
    await repository.patchThreadMetadata(next.task.id, { expectedRevision: 1, archived: true });
    assert.equal((await repository.getThreadMetadata(task.id)).archived, true);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metadata pagination is bounded and stable and invalid input never mutates storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-metadata-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    for (let i = 0; i < 102; i++) {
      const { task } = await repository.createTask(input());
      await repository.patchThreadMetadata(task.id, { expectedRevision: 0, sortOrder: i });
    }
    const first = await repository.listThreadMetadata('');
    assert.equal(first.items.length, 100);
    const second = await repository.listThreadMetadata(first.nextAfter!);
    assert.equal(second.items.length, 2);
    assert.equal(second.nextAfter, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.taskId)).size, 102);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metadata patch is closed, bounded and strict', () => {
  for (const input of [null, [], {}, { expectedRevision: 0 }, { expectedRevision: -1, pinned: true }, { expectedRevision: 0, pinned: null }, { expectedRevision: 0, extra: true }, { expectedRevision: 0, title: 'a'.repeat(257) }, { expectedRevision: 0, title: '\n' }, { expectedRevision: 0, snoozedUntil: 9e15 }, { expectedRevision: 0, sortOrder: Infinity }]) {
    assert.throws(() => parseThreadMetadataPatch(input), { code: 'invalid_input' });
  }
  assert.deepEqual(parseThreadMetadataPatch({ expectedRevision: 0, title: null, snoozedUntil: null, sortOrder: -0.5 }), { expectedRevision: 0, title: null, snoozedUntil: null, sortOrder: -0.5 });
});

test('thread reorder commits a coherent order and rejects foreign projects or sections without writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-order-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { task } = await repository.createTask(input());
      ids.push(task.id); await repository.queueTask(task.id, i === 3 ? 'foreign' : 'project');
    }
    const result = await repository.reorderThread(ids[0]!, { targetTaskId: ids[2]!, placement: 'after' });
    const ordered = result.items.toSorted((a, b) => a.sortOrder! - b.sortOrder!).map(item => item.taskId);
    assert.equal(ordered.indexOf(ids[0]!), ordered.indexOf(ids[2]!) + 1);
    const before = await repository.listThreadMetadata('');
    await assert.rejects(repository.reorderThread(ids[0]!, { targetTaskId: ids[3]!, placement: 'before' }), { code: 'conflict' });
    assert.deepEqual(await repository.listThreadMetadata(''), before);
    await repository.patchThreadMetadata(ids[1]!, { expectedRevision: (await repository.getThreadMetadata(ids[1]!)).revision, settledAt: 0 });
    await assert.rejects(repository.reorderThread(ids[0]!, { targetTaskId: ids[1]!, placement: 'after' }), { code: 'conflict' });
    assert.deepEqual(await repository.reorderThread(ids[0]!, { targetTaskId: ids[0]!, placement: 'after' }), { items: [] });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metadata HTTP authenticates and pins identity, validates requests and reports CAS conflicts', async t => {
  const { createRunnerApplication } = await import('../src/server.js');
  const { openRunnerServices } = await import('../src/runtime.js');
  const directory = await mkdtemp(join(tmpdir(), 'runner-metadata-http-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(directory, runnerId);
  const app = await createRunnerApplication({ runnerId, name: 'metadata', protocolVersion: 1, capabilities: { taskExecution: false, eventReplay: true } }, header => header === 'Bearer metadata-test', services);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${address.port}/v1`;
  const headers = { authorization: 'Bearer metadata-test', 'x-codevo-runner-id': runnerId, 'content-type': 'application/json' };
  const taskResponse = await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify(input()) });
  assert.equal(taskResponse.status, 201);
  const { task } = await taskResponse.json() as { task: { id: string } };
  const url = `${base}/tasks/${task.id}/thread-metadata`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
  assert.equal((await fetch(url, { headers: { authorization: headers.authorization } })).status, 409);
  assert.equal((await fetch(url, { headers })).status, 200);
  const patch = (body: unknown) => fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await patch({ expectedRevision: 0, pinned: true, extra: true })).status, 400);
  assert.equal((await patch({ expectedRevision: 0, title: 'x'.repeat(4096) })).status, 413);
  assert.equal((await patch({ expectedRevision: 0, title: 'Server title' })).status, 200);
  assert.equal((await patch({ expectedRevision: 0, pinned: true })).status, 409);
  assert.equal((await fetch(`${base}/tasks/${randomUUID()}/thread-metadata`, { headers })).status, 404);
  const page = await (await fetch(`${base}/thread-metadata`, { headers })).json() as { items: unknown[]; nextAfter: unknown };
  assert.equal(page.items.length, 1); assert.equal(page.nextAfter, null);
});

test('thread reorder rejects overlarge same-section writes atomically and metadata rejects conflicting organization states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-order-bound-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const ids: string[] = [];
    for (let i = 0; i < 257; i++) {
      const { task } = await repository.createTask(input()); ids.push(task.id);
      await repository.queueTask(task.id, 'project');
    }
    await assert.rejects(repository.reorderThread(ids[0]!, { targetTaskId: ids[1]!, placement: 'after' }), { code: 'quota_exceeded' });
    assert.equal((await repository.listThreadMetadata('')).items.length, 0);
    await repository.patchThreadMetadata(ids[256]!, { expectedRevision: 0, settledAt: 0 });
    const result = await repository.reorderThread(ids[0]!, { targetTaskId: ids[1]!, placement: 'after' });
    assert.equal(result.items.length, 256);
    await assert.rejects(repository.patchThreadMetadata(ids[256]!, { expectedRevision: 1, snoozedUntil: Date.now() + 1000 }), { code: 'invalid_input' });
    assert.equal((await repository.getThreadMetadata(ids[256]!)).revision, 1);
    await repository.patchThreadMetadata(ids[256]!, { expectedRevision: 1, snoozedUntil: Date.now() + 1000, settledAt: null });
    assert.equal((await repository.getThreadMetadata(ids[256]!)).settledAt, null);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('accepted continuation wakes settled or snoozed thread atomically; failed and replayed admissions preserve state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-wake-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const { task } = await repository.createTask(input());
    await repository.queueTask(task.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(task.id, { exitCode: 0, sessionId: randomUUID() });
    await repository.patchThreadMetadata(task.id, { expectedRevision: 0, settledAt: 123, pinned: true, archived: true });
    await assert.rejects(repository.continueTask(task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'attachment', attachmentId: randomUUID() }] }), { code: 'not_found' });
    assert.equal((await repository.getThreadMetadata(task.id)).settledAt, 123);
    const request = { idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Next' }] };
    const next = await repository.continueTask(task.id, request);
    const metadata = await repository.getThreadMetadata(task.id);
    assert.equal(metadata.settledAt, null); assert.equal(metadata.revision, 2);
    assert.equal(metadata.archived, true); assert.equal(metadata.pinned, true);
    await repository.patchThreadMetadata(task.id, { expectedRevision: 2, snoozedUntil: Date.now() + 1000 });
    await repository.continueTask(task.id, request);
    assert.notEqual((await repository.getThreadMetadata(task.id)).snoozedUntil, null);
    await repository.claimNextTask(); await repository.finishTask(next.task.id, { exitCode: 0 });
    await repository.continueTask(next.task.id, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Again' }] });
    assert.equal((await repository.getThreadMetadata(task.id)).snoozedUntil, null);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
