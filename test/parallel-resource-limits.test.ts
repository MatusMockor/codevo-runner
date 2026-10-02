import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { QuestionService } from '../src/application/question-service.js';
import { EXECUTION_LIMITS } from '../src/domain/execution.js';
import type { AgentQuestion } from '../src/domain/questions.js';
import { FileTurnChangesStore } from '../src/infrastructure/projects/turn-changes.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

async function repositoryFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'parallel-resources-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return repository;
}

test('SQLite admits parallel execution bursts above 64 while retaining a hard outstanding limit', async t => {
  const repository = await repositoryFixture(t);
  const { task } = await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{ type: 'text', text: 'test' }] });
  const results = await Promise.all(Array.from({ length: 128 }, () => repository.getTask(task.id)));
  assert.ok(results.every(result => result.id === task.id));
  const limit = EXECUTION_LIMITS.activeTasks * 8 + 64;
  // No event-loop yield: worker replies cannot clear pending requests during admission.
  const burst = Array.from({ length: limit }, () => repository.getTask(task.id));
  await assert.rejects(repository.getTask(task.id), { code: 'busy' });
  await Promise.all(burst);
  assert.equal((await repository.getTask(task.id)).id, task.id);
});

const question: AgentQuestion = { id: 'choice', header: 'Choice', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes', description: 'Continue this task.' }], multiple: false, allowCustom: true };

test('64 durable question waiters route answers and cancellation independently and reject overflow', async t => {
  const repository = await repositoryFixture(t);
  const service = new QuestionService(repository);
  const tasks = [];
  for (let index = 0; index < EXECUTION_LIMITS.activeTasks; index++) {
    const { task } = await repository.createTask({ idempotencyKey: randomUUID(), provider: index % 2 ? 'claude' : 'codex', parts: [{ type: 'text', text: 'ask' }] });
    await repository.queueTask(task.id, 'project'); await repository.claimNextTask(); tasks.push(task);
  }
  const aborts = tasks.map(() => new AbortController());
  const answers = tasks.map((task, index) => service.ask(task, [question], aborts[index]!.signal));
  for (const answer of answers) void answer.catch(() => undefined);
  t.after(async () => { aborts.forEach(abort => abort.abort()); await Promise.allSettled(answers); });
  await assert.rejects(service.ask(tasks[0]!, [question], new AbortController().signal), { code: 'busy' });
  const requests = await Promise.all(tasks.map(task => service.list(task.id)));
  assert.ok(requests.every(request => request.length === 1 && request[0]!.status === 'pending'));
  aborts[0]!.abort();
  await assert.rejects(answers[0]!, { code: 'conflict' });
  for (let index = 1; index < tasks.length; index++) {
    const response = { answers: [{ questionId: 'choice', optionIds: ['yes'], text: `Task ${index}` }] };
    await service.answer(tasks[index]!.id, requests[index]![0]!.id, response);
    assert.deepEqual(await answers[index], response);
  }
  assert.equal((await service.list(tasks[0]!.id))[0]!.status, 'expired');
});

test('parallel snapshot starts retain independent baselines above the former four-operation limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-snapshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const info = await stat(cwd);
  const identity = { dev: info.dev, ino: info.ino };
  const store = new FileTurnChangesStore(join(root, 'state'));
  const signal = new AbortController().signal;
  const ids = Array.from({ length: 8 }, () => randomUUID());
  await writeFile(join(cwd, 'file.txt'), 'before\n');
  await Promise.all(ids.map(id => store.captureStart(id, cwd, identity, signal)));
  await writeFile(join(cwd, 'file.txt'), 'after\n');
  await Promise.all(ids.map(id => store.captureEnd(id, cwd, identity, signal)));
  for (const id of ids) {
    assert.equal((await store.summary(id)).state, 'ready');
    const diff = await store.diff(id, 'file.txt');
    assert.equal(diff.original.text, 'before\n'); assert.equal(diff.modified.text, 'after\n');
  }
  const admitted = Array.from({ length: EXECUTION_LIMITS.activeTasks * 2 }, () => store.captureStart(ids[0]!, cwd, identity, signal));
  await assert.rejects(store.captureStart(randomUUID(), cwd, identity, signal), { code: 'busy' });
  await Promise.all(admitted);
});
