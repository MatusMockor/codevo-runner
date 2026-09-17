import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskInput } from '../src/domain/task-input.js';
import { parseContinueTask } from '../src/domain/task-resume.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const message = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Work' }] });
test('isolation is a closed create-only choice and omission preserves legacy payloads', () => {
  const input = { ...message(), provider: 'claude' as const };
  assert.equal(Object.hasOwn(parseTaskInput(input), 'isolation'), false);
  for (const isolation of ['in-place', 'worktree'] as const) assert.equal(parseTaskInput({ ...input, isolation }).isolation, isolation);
  for (const isolation of [null, undefined, 'local', '', {}, false]) assert.throws(() => parseTaskInput({ ...input, isolation }), { code: 'invalid_input' });
  assert.throws(() => parseContinueTask({ ...message(), isolation: 'in-place' }), { code: 'invalid_input' });
});

test('isolation persists, fences create retries and survives pending and continuation turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isolation-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    for (const isolation of [undefined, 'in-place', 'worktree'] as const) {
      const input = { ...message(), provider: 'claude' as const, ...(isolation === undefined ? {} : { isolation }) };
      const root = (await repository.createTask(input)).task;
      assert.equal(root.isolation, isolation);
      assert.equal((await repository.createTask(input)).created, false);
      await assert.rejects(repository.createTask({ ...input, isolation: isolation === 'in-place' ? 'worktree' : 'in-place' }), { code: 'conflict' });
      await repository.queueTask(root.id, 'project');
      await repository.claimNextTask();
      await repository.enqueuePending(root.id, message());
      await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
      await repository.close();
      repository = await openSqliteRepository(directory, runnerId);
      assert.equal((await repository.getTask(root.id)).isolation, isolation);
      const pending = await repository.promotePending();
      assert.equal(pending?.isolation, isolation);
      assert.ok(pending);
      await repository.claimNextTask();
      await repository.finishTask(pending.id, { exitCode: 0 });
      const continued = await repository.continueTask(pending.id, message());
      assert.equal(continued.task.isolation, isolation);
      await repository.claimNextTask();
      await repository.finishTask(continued.task.id, { exitCode: 0 });
    }
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
