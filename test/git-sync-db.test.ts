import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const draft = (isolation?: 'in-place' | 'worktree') => ({ idempotencyKey: randomUUID(), provider: 'claude' as const,
  ...(isolation ? { isolation } : {}), parts: [{ type: 'text' as const, text: 'Work' }] });

test('schema 8 migrates to 9 with a nullable git base and a newer schema is refused untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-git-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runnerId = randomUUID();
  const first = await openSqliteRepository(directory, runnerId);
  const legacy = (await first.createTask(draft())).task;
  await first.close();
  const old = new DatabaseSync(join(directory, 'runner.sqlite'));
  old.exec('ALTER TABLE tasks DROP COLUMN git_base; PRAGMA user_version=8'); old.close();

  const repository = await openSqliteRepository(directory, runnerId);
  try {
    assert.equal((await repository.getTask(legacy.id)).status, 'draft');
    await repository.queueTask(legacy.id, 'project');
    assert.equal(await repository.getTaskGitBase(legacy.id), undefined);
    await repository.queueTask(legacy.id, 'project');
    await assert.rejects(repository.queueTask(legacy.id, 'project', { kind: 'checkout-head' }), { code: 'conflict' });
    const based = (await repository.createTask(draft())).task;
    await repository.queueTask(based.id, 'project', { kind: 'origin-branch', branch: 'feature/a+b' });
    assert.deepEqual(await repository.getTaskGitBase(based.id), { kind: 'origin-branch', branch: 'feature/a+b' });
    await repository.queueTask(based.id, 'project', { kind: 'origin-branch', branch: 'feature/a+b' });
    await assert.rejects(repository.queueTask(based.id, 'project', { kind: 'origin-branch', branch: 'main' }), { code: 'conflict' });
    const invalid = (await repository.createTask(draft())).task;
    await assert.rejects(repository.queueTask(invalid.id, 'project', { kind: 'origin-branch', branch: '+main' }), { code: 'invalid_input' });
    assert.equal((await repository.getTask(invalid.id)).status, 'draft');
  } finally { await repository.close(); }
  const check = new DatabaseSync(join(directory, 'runner.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 9);
  assert.ok(check.prepare('PRAGMA table_info(tasks)').all().some(column => column['name'] === 'git_base'));
  check.exec('PRAGMA user_version=10'); check.close();
  await assert.rejects(openSqliteRepository(directory, runnerId), { code: 'storage_unavailable' });
  const unchanged = new DatabaseSync(join(directory, 'runner.sqlite'));
  assert.equal(unchanged.prepare('PRAGMA user_version').get()!['user_version'], 10); unchanged.close();
});

test('conversation and in-place activity follow queued and running turns only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-git-activity-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const worktree = (await repository.createTask(draft('worktree'))).task;
  const inPlace = (await repository.createTask(draft('in-place'))).task;
  assert.equal(await repository.conversationActive(worktree.id), false);
  await repository.queueTask(worktree.id, 'project');
  assert.equal(await repository.conversationActive(worktree.id), true);
  assert.equal(await repository.inPlaceActive('project'), false);
  await repository.queueTask(inPlace.id, 'project');
  assert.equal(await repository.inPlaceActive('project'), true);
  assert.equal(await repository.inPlaceActive('other'), false);
  await repository.cancelTask(worktree.id);
  await repository.cancelTask(inPlace.id);
  assert.equal(await repository.conversationActive(worktree.id), false);
  assert.equal(await repository.inPlaceActive('project'), false);
});
