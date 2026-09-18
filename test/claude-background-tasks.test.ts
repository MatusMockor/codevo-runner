import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeBackgroundTasks } from '../src/domain/claude-background-tasks.js';
const event = (subtype: string, task_id: string, extra = {}) => ({ type: 'system', subtype, task_id, ...extra });
test('only root actual starts retain work; prose, nested work, inert plans and unknown progress do not', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.observe({ type: 'assistant', text: 'I will watch this pipeline' }, 's');
  tasks.observe(event('task_progress', 'unknown'), 's');
  tasks.observe(event('task_started', 'nested', { parent_tool_use_id: 'parent' }), 's');
  tasks.observe(event('task_started', 'plan', { task_type: 'plan' }), 's');
  assert.equal(tasks.active, false);
});
test('completed-before-start and duplicated events cannot resurrect a task', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.observe(event('task_notification', 'a', { status: 'completed' }), 's');
  tasks.observe(event('task_started', 'a'), 's');
  assert.equal(tasks.active, false);
  tasks.observe(event('task_started', 'b'), 's');
  tasks.observe(event('task_started', 'b'), 's');
  tasks.observe(event('task_notification', 'b', { status: 'running' }), 's');
  assert.equal(tasks.active, true);
  tasks.observe(event('task_updated', 'b', { patch: { status: 'paused' } }), 's');
  assert.equal(tasks.active, true);
  tasks.observe(event('task_updated', 'b', { patch: { status: 'running' } }), 's');
  tasks.observe(event('task_updated', 'b', { patch: { status: 'completed' } }), 's');
  assert.equal(tasks.active, false);
});
test('task IDs, sessions, live work and retained tombstones are bounded', () => {
  const tasks = new ClaudeBackgroundTasks();
  assert.throws(() => tasks.observe(event('task_started', 'x'), undefined));
  assert.throws(() => tasks.observe(event('task_started', 'x', { session_id: 'foreign' }), 's'));
  assert.throws(() => tasks.observe(event('task_started', 'é'.repeat(129)), 's'));
  for (let i = 0; i < 256; i++) tasks.observe(event('task_started', String(i)), 's');
  assert.throws(() => tasks.observe(event('task_started', 'overflow'), 's'), /background_task_limit/);
  const ended = new ClaudeBackgroundTasks();
  for (let i = 0; i < 4096; i++) ended.observe(event('task_notification', String(i), { status: 'completed' }), 's');
  assert.throws(() => ended.observe(event('task_notification', 'overflow', { status: 'completed' }), 's'), /background_task_limit/);
});
