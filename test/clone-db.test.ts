import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
const input = (name = 'example') => ({ idempotencyKey: randomUUID(), url: 'https://example.com/team/repo.git', name });

test('clone replay, name reservations, atomic registration and runner identity survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-db-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const request = { ...input(), parentPath: '/srv/projects/team' };
    const job = await repository.createClone(request);
    assert.deepEqual(await repository.createClone(request), job);
    await assert.rejects(repository.createClone({ ...request, branch: 'other' }), { code: 'conflict' });
    await assert.rejects(repository.createClone({ ...request, parentPath: '/srv/projects/other' }), { code: 'conflict' });
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual(await repository.createClone(request), job);
    await assert.rejects(repository.createClone(input()), { code: 'conflict' });
    assert.deepEqual(await repository.claimClone(), { job: { ...job, status: 'running' }, input: request });
    assert.equal(await repository.claimClone(), null);
    const project = { id: 'example', name: 'example', path: '/home/user/Developer/example' };
    const completed = await repository.finishClone(job.id, 'succeeded', project, null);
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(await repository.listManagedProjects(), [project]);
    assert.deepEqual(await repository.cancelClone(job.id), completed);
    await repository.close();
    await assert.rejects(openSqliteRepository(directory, randomUUID()), { code: 'conflict' });
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual(await repository.getClone(job.id), completed);
    assert.deepEqual(await repository.listManagedProjects(), [project]);
    await assert.rejects(repository.createClone(input()), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancellation wins completion race and restart interrupts both queued and running clones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-db-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const first = await repository.createClone(input());
    await repository.claimClone();
    await repository.cancelClone(first.id);
    assert.equal((await repository.finishClone(first.id, 'succeeded', { id: 'example', name: 'example', path: '/tmp/example' }, null)).status, 'cancelled');
    assert.deepEqual(await repository.listManagedProjects(), []);
    const second = await repository.createClone(input());
    await repository.claimClone();
    const third = await repository.createClone(input('another'));
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    await repository.interruptClones();
    await repository.interruptClones();
    assert.equal((await repository.getClone(first.id)).status, 'cancelled');
    for (const job of [second, third]) assert.equal((await repository.getClone(job.id)).status, 'interrupted');
    assert.equal(await repository.claimClone(), null);
    await repository.createClone(input());
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('clone admission caps queue and managed project reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    await assert.rejects(repository.createClone(input('no-capacity'), 0), { code: 'quota_exceeded' });
    const reservation = await repository.createClone(input('reserved'), 1);
    await assert.rejects(repository.createClone(input('configured-capacity'), 1), { code: 'quota_exceeded' });
    await repository.cancelClone(reservation.id);
    const jobs = [];
    for (let i = 0; i < 8; i++) jobs.push(await repository.createClone(input(`queue-${i}`)));
    await assert.rejects(repository.createClone(input('overflow')), { code: 'busy' });
    for (const job of jobs) await repository.cancelClone(job.id);
    for (let i = 0; i < 32; i++) {
      const name = `managed-${i}`;
      const job = await repository.createClone(input(name));
      assert.equal((await repository.claimClone())!.job.id, job.id);
      await repository.finishClone(job.id, 'succeeded', { id: name, name, path: `/tmp/${name}` }, null);
    }
    assert.equal((await repository.listManagedProjects()).length, 32);
    await assert.rejects(repository.createClone(input('overflow')), { code: 'quota_exceeded' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid successful registration rolls back and preserves the running clone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-db-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const job = await repository.createClone(input());
    await repository.claimClone();
    await assert.rejects(repository.finishClone(job.id, 'succeeded', null, null), { code: 'invalid_input' });
    await assert.rejects(repository.finishClone(job.id, 'succeeded', { id: 'wrong', name: 'wrong', path: '/tmp/wrong' }, null), { code: 'invalid_input' });
    assert.equal((await repository.getClone(job.id)).status, 'running');
    assert.deepEqual(await repository.listManagedProjects(), []);
    assert.equal((await repository.finishClone(job.id, 'failed', null, 'clone_failed')).error, 'clone_failed');
    await assert.rejects(repository.getClone(randomUUID()), { code: 'not_found' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});


test('v2 migration preserves tasks and clone job retention remains bounded with replay at capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-db-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'Existing task' }] })).task;
    await repository.close();
    const legacy = new DatabaseSync(join(directory, 'runner.sqlite'));
    try { legacy.exec('DROP TABLE project_clones; DROP TABLE managed_projects; PRAGMA user_version=2'); }
    finally { legacy.close(); }
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual(await repository.getTask(task.id), task);
    const request = { ...input(), parentPath: '/srv/projects/team' };
    const first = await repository.createClone(request);
    await repository.cancelClone(first.id);
    for (let i = 1; i < 1000; i++) {
      const job = await repository.createClone(input());
      await repository.cancelClone(job.id);
    }
    await assert.rejects(repository.createClone(input()), { code: 'quota_exceeded' });
    assert.equal((await repository.createClone(request)).id, first.id);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
