import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { ARTIFACT_LIMITS, type Artifact } from '../src/domain/artifact.js';
const input = () => ({ idempotencyKey: randomUUID(), provider: 'claude' as const, parts: [{ type: 'text' as const, text: 'Create a design' }] });
const artifact = (taskId: string, sizeBytes = 100): Artifact => ({ id: randomUUID(), taskId, name: 'design.html', mediaType: 'text/html', sizeBytes, sha256: 'a'.repeat(64) });

test('artifact metadata persists immutable captures, isolates tasks and upgrades schema 5', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-artifact-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const first = (await repository.createTask(input())).task.id;
    const second = (await repository.createTask(input())).task.id;
    const value = artifact(first);
    assert.equal(await repository.findArtifact(first, 'design.html'), null);
    assert.deepEqual(await repository.putArtifact(value, 'design.html'), { artifact: value, created: true });
    assert.deepEqual(await repository.putArtifact({ ...value, id: randomUUID(), sha256: 'b'.repeat(64) }, 'design.html'), { artifact: value, created: false });
    assert.equal(await repository.findArtifact(second, 'design.html'), null);
    await assert.rejects(repository.getArtifact(second, value.id), { code: 'not_found' });
    await assert.rejects(repository.putArtifact({ ...value, taskId: second }, 'design.html'), { code: 'conflict' });
    await assert.rejects(repository.putArtifact(artifact(randomUUID()), 'missing.html'), { code: 'not_found' });
    await assert.rejects(repository.listArtifacts(randomUUID()), { code: 'not_found' });
    await repository.close();
    const db = new DatabaseSync(join(directory, 'runner.sqlite'));
    db.exec('PRAGMA user_version=5'); db.close();
    repository = await openSqliteRepository(directory, runnerId);
    assert.deepEqual(await repository.getArtifact(first, value.id), value);
    assert.deepEqual(await repository.listArtifacts(first), [value]);
    assert.deepEqual(await repository.listArtifacts(second), []);
    await repository.close();
    const check = new DatabaseSync(join(directory, 'runner.sqlite'));
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 8); check.close();
    await assert.rejects(openSqliteRepository(directory, randomUUID()), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('artifact task quota is atomic under concurrent admission and replay survives exhaustion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-artifact-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const taskId = (await repository.createTask(input())).task.id;
    const values = Array.from({ length: ARTIFACT_LIMITS.perTask + 1 }, () => artifact(taskId));
    const results = await Promise.allSettled(values.map((value, index) => repository.putArtifact(value, `design-${index}.html`)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, ARTIFACT_LIMITS.perTask);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'quota_exceeded');
    assert.equal((await repository.listArtifacts(taskId)).length, ARTIFACT_LIMITS.perTask);
    assert.equal((await repository.putArtifact(values[0]!, 'design-0.html')).created, false);
    const second = (await repository.createTask(input())).task.id;
    assert.equal((await repository.putArtifact(artifact(second), 'design.html')).created, true);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('artifact global byte quota is exact across tasks and rejects invalid metadata before accounting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-artifact-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    let first: Artifact | undefined;
    for (let index = 0; index < ARTIFACT_LIMITS.storageBytes / ARTIFACT_LIMITS.imageBytes; index++) {
      if (index % ARTIFACT_LIMITS.perTask === 0) first = artifact((await repository.createTask(input())).task.id);
      const value: Artifact = { ...artifact(first!.taskId, ARTIFACT_LIMITS.imageBytes), mediaType: 'image/png', name: `${index}.png` };
      await repository.putArtifact(value, value.name);
    }
    const lastTask = (await repository.createTask(input())).task.id;
    await assert.rejects(repository.putArtifact(artifact(lastTask), 'overflow.html'), { code: 'quota_exceeded' });
    assert.deepEqual(await repository.listArtifacts(lastTask), []);
    for (const sizeBytes of [-1, 0, 0.5, NaN, ARTIFACT_LIMITS.htmlBytes + 1]) {
      await assert.rejects(repository.putArtifact(artifact(lastTask, sizeBytes), 'invalid.html'), { code: 'invalid_input' });
    }
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('artifact admission rejects obsolete turn after continuation while preserving immutable replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-artifact-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const first = (await repository.createTask(input())).task.id;
    await repository.queueTask(first, 'project');
    await repository.claimNextTask();
    await repository.finishTask(first, { exitCode: 0, sessionId: randomUUID() });
    const original = artifact(first);
    await repository.putArtifact(original, 'design.html');
    const second = (await repository.continueTask(first, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Next' }] })).task.id;
    await assert.rejects(repository.putArtifact(artifact(first), 'late.html'), { code: 'conflict' });
    assert.deepEqual(await repository.putArtifact(artifact(first), 'design.html'), { artifact: original, created: false });
    const latest = artifact(second);
    await repository.putArtifact(latest, 'design.html');
    assert.deepEqual(await repository.listArtifactIds(), [original.id, latest.id]);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
