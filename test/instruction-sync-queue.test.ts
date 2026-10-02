import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { InstructionSyncQueue } from '../src/infrastructure/files/instruction-sync-queue.js';

const signal = () => new AbortController().signal;

test('instruction synchronization is FIFO per directory while unrelated directories proceed', async () => {
  const queue = new InstructionSyncQueue();
  const first = await queue.acquire('1:10', signal());
  const order: number[] = [];
  const second = queue.acquire('1:10', signal()).then(release => { order.push(2); return release; });
  const third = queue.acquire('1:10', signal()).then(release => { order.push(3); return release; });
  const other = await queue.acquire('1:11', signal());
  assert.deepEqual(order, []);
  other();
  first();
  const releaseSecond = await second;
  assert.deepEqual(order, [2]);
  first(); // A repeated release cannot grant another waiter.
  await Promise.resolve();
  assert.deepEqual(order, [2]);
  releaseSecond();
  (await third)();
  assert.deepEqual(order, [2, 3]);
});

test('cancelled waiters free capacity and remove listeners without disturbing FIFO', async () => {
  const queue = new InstructionSyncQueue(3);
  const first = await queue.acquire('root', signal());
  const cancelled = new AbortController();
  const waiting = queue.acquire('root', cancelled.signal);
  const rejection = assert.rejects(waiting, { name: 'AbortError' });
  const nextSignal = signal();
  const next = queue.acquire('root', nextSignal);
  assert.throws(() => queue.acquire('other', signal()), { code: 'busy' });
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 1);
  cancelled.abort();
  await rejection;
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0);
  (await queue.acquire('other', signal()))();
  first();
  (await next)();
  assert.equal(getEventListeners(nextSignal, 'abort').length, 0);
  (await queue.acquire('root', signal()))();
});

test('pre-cancelled requests do not occupy capacity and granted permits remain releasable after abort', async () => {
  const queue = new InstructionSyncQueue(1);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => queue.acquire('root', cancelled.signal), { name: 'AbortError' });
  const active = new AbortController();
  const release = await queue.acquire('root', active.signal);
  active.abort();
  assert.throws(() => queue.acquire('root', signal()), { code: 'busy' });
  release();
  (await queue.acquire('root', signal()))();
});
