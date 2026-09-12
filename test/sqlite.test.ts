import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { LIMITS, type Attachment } from '../src/domain/contracts.js';
const input = () => ({ idempotencyKey: randomUUID(), provider: 'codex' as const, parts: [{ type: 'text' as const, text: 'Implement this' }] });
const attachment = (runnerId: string): Attachment => ({ id: randomUUID(), runnerId, name: 'screen.png', mediaType: 'image/png', bytes: 100, sha256: 'a'.repeat(64), width: 1, height: 1, createdAt: new Date().toISOString() });

test('sqlite persists tasks, immutable attachment replay, cancellation and ordered events across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const file = attachment(runnerId);
    assert.equal((await repository.putAttachment(file)).created, true);
    assert.deepEqual(await repository.putAttachment({ ...file, createdAt: 'later' }), { attachment: file, created: false });
    await assert.rejects(repository.putAttachment({ ...file, name: 'other.png' }), { code: 'conflict' });
    const request = { ...input(), parts: [{ type: 'attachment' as const, attachmentId: file.id }] };
    const created = await repository.createTask(request);
    assert.equal(created.created, true);
    assert.equal(created.task.status, 'draft');
    assert.equal((await repository.createTask(request)).created, false);
    await assert.rejects(repository.createTask({ ...request, provider: 'claude' }), { code: 'conflict' });
    const cancelled = await repository.cancelTask(created.task.id);
    assert.equal(cancelled.status, 'cancelled');
    await repository.cancelTask(created.task.id);
    await repository.close();
    repository = await openSqliteRepository(directory, runnerId);
    assert.deepEqual(await repository.getTask(created.task.id), cancelled);
    assert.deepEqual(await repository.getAttachment(file.id), file);
    const events = await repository.listEvents(created.task.id, 0);
    assert.deepEqual(events.items.map(event => event.type), ['task.created', 'task.cancelled']);
    assert.equal((await repository.listEvents(created.task.id, events.items[0]!.sequence)).items.length, 1);
    await assert.rejects(repository.listEvents(randomUUID(), 0), { code: 'not_found' });
    await repository.close();
    await assert.rejects(repository.listTasks(0), { code: 'storage_unavailable' });
    await assert.rejects(openSqliteRepository(directory, randomUUID()), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite rolls back missing references, enforces task quota and paginates without gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const missing = { ...input(), parts: [{ type: 'attachment' as const, attachmentId: randomUUID() }] };
    await assert.rejects(repository.createTask(missing), { code: 'not_found' });
    assert.equal((await repository.listTasks(0)).items.length, 0);
    const first = input();
    await repository.createTask(first);
    for (let index = 1; index < LIMITS.tasks; index++) await repository.createTask(input());
    assert.equal((await repository.createTask(first)).created, false);
    await assert.rejects(repository.createTask(input()), { code: 'quota_exceeded' });
    const sequences: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = await repository.listTasks(cursor);
      sequences.push(...page.items.map(task => task.sequence));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(sequences.length, LIMITS.tasks);
    assert.equal(new Set(sequences).size, LIMITS.tasks);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite attachment storage quota allows exact replay and rejects foreign runner data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(directory, runnerId);
  try {
    const first = { ...attachment(runnerId), bytes: LIMITS.attachmentBytes };
    await repository.putAttachment(first);
    for (let index = 1; index < LIMITS.storageBytes / LIMITS.attachmentBytes; index++) await repository.putAttachment({ ...attachment(runnerId), bytes: LIMITS.attachmentBytes });
    assert.equal((await repository.putAttachment(first)).created, false);
    await assert.rejects(repository.putAttachment(attachment(runnerId)), { code: 'quota_exceeded' });
    await assert.rejects(repository.putAttachment(attachment(randomUUID())), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite rejects unknown schema versions without rewriting database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  try {
    const db = new DatabaseSync(join(directory, 'runner.sqlite'));
    db.exec('PRAGMA user_version=99'); db.close();
    await assert.rejects(openSqliteRepository(directory, randomUUID()), { code: 'storage_unavailable' });
    const check = new DatabaseSync(join(directory, 'runner.sqlite'));
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 99); check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sqlite enforces attachment count quota independently of byte quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(directory, runnerId);
  try {
    const first = attachment(runnerId);
    await repository.putAttachment(first);
    for (let index = 1; index < LIMITS.attachments; index++) await repository.putAttachment(attachment(runnerId));
    await assert.rejects(repository.putAttachment(attachment(runnerId)), { code: 'quota_exceeded' });
    assert.equal((await repository.putAttachment(first)).created, false);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite bounds outstanding operations and drains accepted calls before close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const operations = Array.from({ length: 65 }, () => repository.listTasks(0));
    const results = Promise.allSettled(operations);
    const closing = repository.close();
    assert.equal(repository.close(), closing);
    const settled = await results;
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 64);
    const rejected = settled[64];
    assert.equal(rejected?.status, 'rejected');
    if (rejected?.status === 'rejected') assert.equal(rejected.reason.code, 'busy');
    await closing;
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite full preserves quota error after automatic rollback and leaves no partial task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(directory, runnerId);
  let created = 0;
  try {
    const largeText = 'x'.repeat(LIMITS.textBytes);
    let failure: unknown;
    for (; created < LIMITS.tasks; created++) {
      try { await repository.createTask({ ...input(), parts: [{ type: 'text', text: largeText }] }); }
      catch (error) { failure = error; break; }
    }
    assert.ok(created > 0 && created < LIMITS.tasks, 'database page budget must fill before task count quota');
    assert.equal((failure as { code: string }).code, 'quota_exceeded');
    let persisted = 0;
    let cursor = 0;
    for (;;) {
      const page = await repository.listTasks(cursor);
      persisted += page.items.length;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(persisted, created);
    await repository.close();
    const db = new DatabaseSync(join(directory, 'runner.sqlite'));
    try {
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM events').get()!['n']), created);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM tasks').get()!['n']), created);
    } finally { db.close(); }
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('sqlite leases a data directory exclusively and releases ownership on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-db-'));
  const runnerId = randomUUID();
  const first = await openSqliteRepository(directory, runnerId);
  try {
    const created = await first.createTask(input());
    await assert.rejects(openSqliteRepository(directory, runnerId), { code: 'busy' });
    assert.deepEqual(await first.getTask(created.task.id), created.task);
    await first.close();
    const replacement = await openSqliteRepository(directory, runnerId);
    try { assert.deepEqual(await replacement.getTask(created.task.id), created.task); }
    finally { await replacement.close(); }
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});
