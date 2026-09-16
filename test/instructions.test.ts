import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInstructionSnapshot, type InstructionSnapshot } from '../src/domain/instructions.js';
import { parseTaskInput } from '../src/domain/task-input.js';
import { parseContinueTask } from '../src/domain/task-resume.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

const snapshot = (content = 'Use project conventions'): InstructionSnapshot => ({ version: 1, files: [{ scope: 'global', path: 'CLAUDE.md', content }, { scope: 'project', path: 'nested/CLAUDE.local.md', content }] });
const input = () => ({ idempotencyKey: randomUUID(), parts: [{ type: 'text' as const, text: 'Work' }] });

test('instruction snapshots validate closed fields and freeze independent copies', () => {
  const value = { version: 1, files: [{ scope: 'project', path: 'CLAUDE.md', content: 'old' }] };
  const parsed = parseInstructionSnapshot(value);
  value.files[0]!.content = 'new';
  assert.equal(parsed.files[0]!.content, 'old');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.files) && Object.isFrozen(parsed.files[0]));
  assert.deepEqual(parseTaskInput({ ...input(), provider: 'claude', instructions: snapshot() }).instructions, snapshot());
  assert.deepEqual(parseContinueTask({ ...input(), instructions: snapshot() }).instructions, snapshot());
  for (const bad of [null, { version: 2, files: [] }, { version: 1, files: [], extra: true }, { version: 1, files: [{ ...snapshot().files[0], extra: true }] }, { version: 1, files: [{ ...snapshot().files[0], scope: 'machine' }] }]) {
    assert.throws(() => parseInstructionSnapshot(bad), { code: 'invalid_input' });
  }
});

test('instruction snapshots reject traversal, aliases, collisions and bounded exhaustion', () => {
  for (const path of ['/CLAUDE.md', '../CLAUDE.md', 'a/../CLAUDE.md', 'a//CLAUDE.md', './CLAUDE.md', 'C:/CLAUDE.md', 'a\\CLAUDE.md', 'bad\0.md', 'a /CLAUDE.md', 'a./CLAUDE.md', 'settings.json']) {
    assert.throws(() => parseInstructionSnapshot({ version: 1, files: [{ scope: 'project', path, content: '' }] }), { code: 'invalid_input' }, path);
  }
  for (const paths of [['CLAUDE.md', 'claude.md'], ['a.md', 'a.md/CLAUDE.md'], ['é.md', 'e\u0301.md']]) {
    assert.throws(() => parseInstructionSnapshot({ version: 1, files: paths.map(path => ({ scope: 'project', path, content: '' })) }), { code: 'invalid_input' });
  }
  for (const files of [
    Array.from({ length: 129 }, (_, i) => ({ scope: 'project', path: `${i}.md`, content: '' })),
    [{ scope: 'project', path: 'a.md', content: 'é'.repeat(32_769) }],
    Array.from({ length: 9 }, (_, i) => ({ scope: 'project', path: `${i}.md`, content: 'x'.repeat(65_536) })),
    [{ scope: 'project', path: `${'é'.repeat(255)}.md`, content: '' }],
    [{ scope: 'project', path: `${'a/'.repeat(32)}b.md`, content: '' }],
  ]) assert.throws(() => parseInstructionSnapshot({ version: 1, files }), { code: 'too_large' });
});

test('snapshots survive persistence and pending promotion, fence retries, and require explicit snapshots on continuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'instructions-db-'));
  const runnerId = randomUUID();
  let repository = await openSqliteRepository(directory, runnerId);
  try {
    const request = { ...input(), provider: 'claude' as const, instructions: snapshot('initial') };
    const root = (await repository.createTask(request)).task;
    assert.deepEqual(root.instructions, request.instructions);
    await assert.rejects(repository.createTask({ ...request, instructions: snapshot('changed') }), { code: 'conflict' });
    assert.equal((await repository.createTask(request)).created, false);
    await repository.queueTask(root.id, 'project');
    await repository.claimNextTask();
    const queued = { ...input(), instructions: snapshot('queued') };
    const pending = await repository.enqueuePending(root.id, queued);
    await assert.rejects(repository.enqueuePending(root.id, { ...queued, instructions: snapshot('other') }), { code: 'conflict' });
    assert.deepEqual(pending.pending.instructions, queued.instructions);
    await repository.finishTask(root.id, { exitCode: 0, sessionId: randomUUID() });
    await repository.close();
    repository = await openSqliteRepository(directory, runnerId);
    assert.deepEqual((await repository.getTask(root.id)).instructions, request.instructions);
    const promoted = await repository.promotePending();
    assert.deepEqual(promoted?.instructions, queued.instructions);
    await repository.claimNextTask();
    await repository.finishTask(promoted!.id, { exitCode: 0 });
    await assert.rejects(repository.continueTask(promoted!.id, input()), { code: 'invalid_input' });
    await assert.rejects(repository.enqueuePending(promoted!.id, input()), { code: 'invalid_input' });
    const continuation = { ...input(), instructions: { version: 1 as const, files: [] } };
    const child = (await repository.continueTask(promoted!.id, continuation)).task;
    assert.deepEqual(child.instructions, { version: 1, files: [] });
    await assert.rejects(repository.continueTask(promoted!.id, { ...continuation, instructions: snapshot() }), { code: 'conflict' });
    await repository.claimNextTask();
    await repository.finishTask(child.id, { exitCode: 0 });
    const empty = (await repository.continueTask(child.id, { ...input(), instructions: { version: 1, files: [] } })).task;
    assert.deepEqual(empty.instructions, { version: 1, files: [] });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
