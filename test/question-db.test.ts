import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { parseAgentQuestionRequest, parseAgentQuestionResponse, type AgentQuestionRequest } from '../src/domain/questions.js';

const request = (taskId: string): AgentQuestionRequest => ({ id: randomUUID(), taskId, provider: 'claudeCode', status: 'pending', questions: [{ id: 'q1', header: 'Choice', prompt: 'Choose a path', options: [{ id: 'a', label: 'A', description: '' }, { id: 'b', label: 'B', description: '' }], multiple: false, allowCustom: true }] });
const response = { answers: [{ questionId: 'q1', optionIds: ['a'], text: '' }] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runner-question-db-'));
  const runnerId = randomUUID();
  let changes = 0;
  const repository = await openSqliteRepository(directory, runnerId, () => changes++);
  const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'claude', parts: [{ type: 'text', text: 'Question' }] })).task;
  await repository.queueTask(task.id, 'project'); await repository.claimNextTask();
  return { directory, runnerId, repository, task, changes: () => changes, cleanup: async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('durable answers are isolated, validated, idempotent and notify after commit', async () => {
  const f = await fixture();
  try {
    const q = request(f.task.id);
    const before = f.changes();
    assert.deepEqual(await f.repository.createQuestion(q), q);
    assert.ok(f.changes() > before);
    assert.deepEqual(await f.repository.createQuestion(q), q);
    await assert.rejects(f.repository.createQuestion(request(f.task.id)), { code: 'conflict' });
    await assert.rejects(f.repository.answerQuestion(f.task.id, randomUUID(), response), { code: 'not_found' });
    await assert.rejects(f.repository.answerQuestion(f.task.id, q.id, { answers: [{ questionId: 'q1', optionIds: ['missing'], text: '' }] }), { code: 'invalid_input' });
    await assert.rejects(f.repository.answerQuestion(f.task.id, q.id, { answers: [{ questionId: 'q1', optionIds: ['a', 'b'], text: '' }] }), { code: 'invalid_input' });
    const answered = await f.repository.answerQuestion(f.task.id, q.id, response);
    assert.equal(answered.status, 'answered');
    assert.deepEqual(await f.repository.answerQuestion(f.task.id, q.id, response), answered);
    await assert.rejects(f.repository.answerQuestion(f.task.id, q.id, { answers: [{ questionId: 'q1', optionIds: [], text: 'different' }] }), { code: 'conflict' });
    await f.repository.finishTask(f.task.id, { exitCode: 0 });
    assert.deepEqual(await f.repository.answerQuestion(f.task.id, q.id, response), answered);
    await f.repository.close();
    const reopened = await openSqliteRepository(f.directory, f.runnerId);
    try { assert.deepEqual(await reopened.listQuestions(f.task.id), [answered]); }
    finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test('terminal cancellation and restart expire questions atomically, rejecting late answers', async () => {
  for (const transition of ['cancel', 'finish', 'interrupt'] as const) {
    const f = await fixture();
    try {
      const q = request(f.task.id); await f.repository.createQuestion(q);
      if (transition === 'cancel') await f.repository.cancelTask(f.task.id);
      else if (transition === 'finish') await f.repository.finishTask(f.task.id, { exitCode: 0 });
      else await f.repository.interruptRunningTasks();
      assert.equal((await f.repository.listQuestions(f.task.id))[0]?.status, transition === 'cancel' ? 'cancelled' : 'expired');
      await assert.rejects(f.repository.answerQuestion(f.task.id, q.id, response), { code: 'conflict' });
      await assert.rejects(f.repository.createQuestion(request(f.task.id)), { code: 'conflict' });
    } finally { await f.cleanup(); }
  }
});

test('schema seven migration preserves tasks and per-task question quota stays bounded', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.repository.createQuestion({ ...request(f.task.id), provider: 'codex' }), { code: 'conflict' });
    for (let index = 0; index < 32; index++) {
      const q = request(f.task.id); await f.repository.createQuestion(q); await f.repository.answerQuestion(f.task.id, q.id, response);
    }
    await assert.rejects(f.repository.createQuestion(request(f.task.id)), { code: 'quota_exceeded' });
    await f.repository.close();
    const database = new DatabaseSync(join(f.directory, 'runner.sqlite'));
    database.exec('PRAGMA user_version=7'); database.close();
    const reopened = await openSqliteRepository(f.directory, f.runnerId);
    try { assert.equal((await reopened.listQuestions(f.task.id)).length, 32); assert.equal((await reopened.getTask(f.task.id)).status, 'running'); }
    finally { await reopened.close(); }
    const check = new DatabaseSync(join(f.directory, 'runner.sqlite'));
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 8); check.close();
  } finally { await f.cleanup(); }
});

test('question wire rejects extras, duplicate IDs, byte overflow and wrong answer membership', () => {
  const q = request(randomUUID());
  assert.throws(() => parseAgentQuestionRequest({ ...q, surprise: true }));
  assert.throws(() => parseAgentQuestionRequest({ ...q, questions: [...q.questions, ...q.questions] }));
  assert.throws(() => parseAgentQuestionRequest({ ...q, questions: [{ ...q.questions[0], prompt: '😀'.repeat(2049) }] }));
  assert.throws(() => parseAgentQuestionResponse({ answers: [] }, q));
  assert.throws(() => parseAgentQuestionResponse({ answers: [...response.answers, ...response.answers] }, q));
  assert.deepEqual(parseAgentQuestionResponse({ answers: [{ questionId: 'q1', optionIds: [], text: 'Custom answer' }] }, q).answers[0]?.text, 'Custom answer');
});

test('serialized task question budget counts JSON escaping and reserves the largest legal answer', async () => {
  const f = await fixture();
  try {
    let admitted = 0;
    for (let index = 0; index < 32; index++) {
      const q: AgentQuestionRequest = {
        ...request(f.task.id),
        questions: Array.from({ length: 4 }, (_, index) => ({
          id: `q${index}`, header: '', prompt: '\u0001'.repeat(8192),
          options: [], multiple: false, allowCustom: true,
        })),
      };
      try { await f.repository.createQuestion(q); }
      catch (error) {
        assert.equal((error as { code: string }).code, 'quota_exceeded');
        break;
      }
      admitted++;
      // Every admitted request must retain enough room for all maximal escaped answers.
      await f.repository.answerQuestion(f.task.id, q.id, { answers: q.questions.map(question => ({
        questionId: question.id, optionIds: [], text: '\u0002'.repeat(8192),
      })) });
    }
    assert.ok(admitted > 0 && admitted < 32);
    const stored = await f.repository.listQuestions(f.task.id);
    assert.equal(stored.length, admitted);
    assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 1024 * 1024);
    assert.ok(stored.every(item => item.status === 'answered'));
  } finally { await f.cleanup(); }
});


test('multibyte question history also fits ASCII-escaped native transport', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 32; index++) {
      const q: AgentQuestionRequest = { ...request(f.task.id), questions: Array.from({ length: 4 }, (_, i) => ({
        id: `q${i}`, header: '', prompt: 'é'.repeat(4096), options: Array.from({ length: 12 }, (_, j) => ({
          id: `o${j}`, label: 'é'.repeat(256), description: 'é'.repeat(1024),
        })), multiple: true, allowCustom: true,
      })) };
      try { await f.repository.createQuestion(q); }
      catch (error) { assert.equal((error as { code: string }).code, 'quota_exceeded'); break; }
      await f.repository.answerQuestion(f.task.id, q.id, { answers: q.questions.map(question => ({ questionId: question.id,
        optionIds: question.options.map(option => option.id), text: 'é'.repeat(4096),
      })) });
    }
    const stored = await f.repository.listQuestions(f.task.id);
    assert.ok(stored.length > 0 && stored.length < 32);
    const json = JSON.stringify({ items: stored });
    // Equivalent to Python json.dumps ensure_ascii=True, used by the SSH helper.
    const ascii = json.replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    assert.ok(Buffer.byteLength(ascii) < 3 * 1024 * 1024);
  } finally { await f.cleanup(); }
});
