import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskInput } from '../src/domain/task-input.js';
import { parseContinueTask } from '../src/domain/task-resume.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { folderProjectRunner } from './folder-project-fixture.js';

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

test('a folder project starts only explicitly in-place tasks without an origin base and refused drafts stay drafts', { timeout: 30_000 }, async t => {
  const state = await folderProjectRunner(t, async () => []);
  const repository = await state.repository('repo');
  const folder = await state.registerFolder('workspace');
  assert.deepEqual((await state.register(repository, 'repo')).body, { status: 'registered', project: { id: 'repo', name: 'repo' }, created: true });
  const cwds: string[] = [];
  state.provider(async request => {
    cwds.push(request.cwd);
    return { exitCode: 0, sessionId: randomUUID() };
  });
  const origin = { kind: 'origin-branch', branch: 'main' };
  const worktree = await state.draft('worktree'), omitted = await state.draft(), based = await state.draft('in-place'), direct = await state.draft('in-place');
  const refused: readonly (readonly [string, unknown])[] = [
    [worktree.id, { projectId: 'workspace' }], [worktree.id, { projectId: 'workspace', base: { kind: 'checkout-head' } }], [worktree.id, { projectId: 'workspace', base: origin }],
    [omitted.id, { projectId: 'workspace' }], [omitted.id, { projectId: 'workspace', base: { kind: 'checkout-head' } }], [based.id, { projectId: 'workspace', base: origin }],
  ];
  for (const [id, body] of refused) {
    const reply = await state.post(`/v1/tasks/${id}/start`, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.deepEqual(await reply.json(), { error: 'invalid_input' });
    const current = await state.task(id);
    assert.deepEqual([current.status, current.projectId], ['draft', undefined], JSON.stringify(body));
  }
  assert.equal(cwds.length, 0);
  assert.equal(state.services.execution!.working, false);
  assert.equal((await state.post(`/v1/tasks/${based.id}/start`, { projectId: 'workspace', base: { kind: 'checkout-head' } })).status, 202);
  assert.equal((await state.post(`/v1/tasks/${direct.id}/start`, { projectId: 'workspace' })).status, 202);
  assert.equal((await state.post(`/v1/tasks/${direct.id}/start`, { projectId: 'workspace' })).status, 202);
  for (const id of [based.id, direct.id]) {
    const done = await state.settled(id);
    assert.deepEqual([done.status, done.projectId, done.isolation], ['succeeded', 'workspace', 'in-place']);
  }
  assert.deepEqual(cwds.slice(), [folder, folder]);
  for (const id of [worktree.id, omitted.id]) {
    assert.equal((await state.post(`/v1/tasks/${id}/start`, { projectId: 'repo' })).status, 202);
    const done = await state.settled(id);
    assert.deepEqual([done.status, done.projectId], ['succeeded', 'repo']);
  }
  assert.deepEqual(cwds.slice(2).map(cwd => cwd.startsWith(join(state.dataDir, 'workspaces'))), [true, true]);
});
