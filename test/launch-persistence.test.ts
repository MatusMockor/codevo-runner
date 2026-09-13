import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { parseTaskInput } from '../src/domain/task-input.js';
import { parseContinueTask } from '../src/domain/task-resume.js';
const input = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Continue' }] });
const claude = { provider: 'claudeCode' as const, model: 'sonnet' as const, mode: 'plan' as const, effort: 'high' as const };
const codex = { provider: 'codex' as const, model: 'default' as const, mode: 'default' as const };

test('launch parsing accepts Claude continuation and rejects unknown fields and provider mismatch', () => {
  assert.equal(parseContinueTask({ ...input(), launch: claude }).launch?.provider, 'claudeCode');
  assert.throws(() => parseTaskInput({ ...input(), provider: 'codex', launch: claude }), { code: 'invalid_input' });
  assert.throws(() => parseContinueTask({ ...input(), launch: claude, extra: true }), { code: 'invalid_input' });
  assert.throws(() => parseContinueTask({ ...input(), launch: null }), { code: 'invalid_input' });
});

test('real SQLite preserves canonical launch, rejects changed retry intent and inherits per-turn options after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-persistence-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const request = parseTaskInput({ ...input(), provider: 'claude', launch: claude });
    const root = (await repository.createTask(request)).task;
    assert.deepEqual(root.launch, request.launch);
    assert.equal((await repository.createTask({ ...request, launch: { ...claude, context: '200k', fastMode: false, thinkingMode: false } })).created, false);
    await assert.rejects(repository.createTask({ ...request, launch: { ...claude, effort: 'low' } }), { code: 'conflict' });
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
    await assert.rejects(repository.continueTask(root.id, { ...input(), launch: codex }), { code: 'invalid_input' });
    const continuation = input();
    const child = (await repository.continueTask(root.id, continuation)).task;
    assert.deepEqual(child.launch, root.launch);
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 0 });
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.deepEqual((await repository.getTask(child.id)).launch, root.launch);
    assert.equal((await repository.continueTask(root.id, continuation)).created, false);
    await assert.rejects(repository.continueTask(root.id, { ...continuation, launch: claude }), { code: 'conflict' });
    const changed = parseContinueTask({ ...input(), launch: { ...claude, effort: 'low' } });
    const third = (await repository.continueTask(child.id, changed)).task;
    assert.deepEqual(third.launch, changed.launch);
    assert.deepEqual((await repository.getTask(child.id)).launch, root.launch);
    assert.equal((await repository.findContinuation(child.id, changed))?.created, false);
    await assert.rejects(repository.findContinuation(child.id, { ...changed, launch: claude }), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('omitting launch preserves legacy task shape and idempotency after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-legacy-'));
  const identity = randomUUID();
  let repository = await openSqliteRepository(directory, identity);
  try {
    const request = { ...input(), provider: 'codex' as const };
    const root = (await repository.createTask(request)).task;
    assert.equal(Object.hasOwn(root, 'launch'), false);
    await repository.close();
    repository = await openSqliteRepository(directory, identity);
    assert.equal((await repository.createTask(request)).created, false);
    await assert.rejects(repository.createTask({ ...request, launch: codex }), { code: 'conflict' });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
