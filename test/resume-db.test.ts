import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
const input = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Continue' }] });

test('continuation preserves root workspace/session, serializes competing turns and survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-db-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const root = (await repository.createTask({ ...input(), provider: 'codex' })).task;
    assert.deepEqual(await repository.getResumeState(root.id), { available: false, reason: 'task_not_finished' });
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    const sessionId = randomUUID();
    await repository.finishTask(root.id, { exitCode: 0, sessionId });
    await assert.rejects(repository.setTaskSession(root.id, randomUUID()), { code: 'conflict' });
    assert.equal((await repository.getTaskSession(root.id)).sessionId, sessionId);
    const request = input();
    assert.equal(await repository.findContinuation(root.id, request), null);
    const results = await Promise.allSettled([repository.continueTask(root.id, request), repository.continueTask(root.id, input())]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results[1].status, 'rejected');
    const child = (await repository.continueTask(root.id, request)).task;
    assert.deepEqual(await repository.findContinuation(root.id, request), { task: child, created: false });
    await assert.rejects(repository.findContinuation(root.id, { ...request, parts: [{ type: 'text', text: 'different' }] }), { code: 'conflict' });
    assert.equal(child.parentTaskId, root.id);
    assert.equal(child.conversationId, root.id);
    assert.equal(child.projectId, 'project');
    assert.equal(child.status, 'queued');
    assert.deepEqual(await repository.getTaskSession(child.id), { sessionId, workspaceTaskId: root.id });
    assert.deepEqual(await repository.getResumeState(root.id), { available: false, reason: 'newer_turn_exists' });
    await assert.rejects(repository.continueTask(root.id, { ...request, parts: [{ type: 'text', text: 'changed' }] }), { code: 'conflict' });
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 1 });
    assert.equal((await repository.getResumeState(child.id)).available, true);
    await repository.setTaskSession(root.id, randomUUID());
    assert.equal((await repository.getTaskSession(child.id)).sessionId, sessionId);
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    const third = (await repository.continueTask(child.id, input())).task;
    assert.equal(third.conversationId, root.id);
    assert.deepEqual(await repository.getTaskSession(third.id), { sessionId, workspaceTaskId: root.id });
    assert.equal((await repository.listEvents(third.id, 0)).items.length, 2);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy canonical stdout restores sessions, missing attachments roll back and unknown sessions fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-legacy-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const root = (await repository.createTask({ ...input(), provider: 'codex' })).task;
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    const sessionId = randomUUID();
    await repository.appendTaskOutput(root.id, 'stdout', JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\n');
    await repository.finishTask(root.id, { exitCode: 0 });
    assert.equal((await repository.getResumeState(root.id)).available, true);
    assert.equal((await repository.getTaskSession(root.id)).sessionId, sessionId);
    const request = input();
    await assert.rejects(repository.continueTask(root.id, { ...request, parts: [{ type: 'attachment', attachmentId: randomUUID() }] }), { code: 'not_found' });
    assert.equal((await repository.getResumeState(root.id)).available, true);
    assert.equal((await repository.continueTask(root.id, request)).created, true);
    const unknown = (await repository.createTask({ ...input(), provider: 'claude' })).task;
    await repository.cancelTask(unknown.id);
    assert.deepEqual(await repository.getResumeState(unknown.id), { available: false, reason: 'session_unavailable' });
    await assert.rejects(repository.continueTask(unknown.id, input()), { code: 'conflict' });
    await assert.rejects(repository.setTaskSession(unknown.id, '--resume bad'), { code: 'invalid_input' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
