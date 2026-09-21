import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyInput } from '../src/infrastructure/terminal/pty-input.js';

test('PTY input cancels pending writes before descriptor reuse, including a backpressured retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let owner = 'old'; const written: string[] = [];
  let blocked = true;
  const input = new PtyInput(42, (_fd, buffer, offset, length) => {
    if (blocked) throw Object.assign(new Error('backpressure'), { code: 'EAGAIN' });
    written.push(`${owner}:${buffer.subarray(offset, offset + length).toString()}`);
    return length;
  });
  input.write('private old input');
  t.mock.timers.tick(1);
  input.close(); owner = 'replacement'; blocked = false;
  t.mock.timers.tick(100);
  assert.deepEqual(written, []);
  assert.throws(() => input.write('late'), /conflict/);
});

test('PTY input keeps partial UTF8 bytes ordered and enforces the pending-byte cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written: Buffer[] = [];
  const input = new PtyInput(42, (_fd, buffer, offset, length) => {
    const count = Math.min(4095, length);
    written.push(buffer.subarray(offset, offset + count)); return count;
  });
  input.write('🙂'.repeat(65_536));
  assert.throws(() => input.write('x'), /busy/);
  for (let tick = 0; tick < 5; tick++) t.mock.timers.tick(10);
  assert.equal(Buffer.concat(written).toString(), '🙂'.repeat(65_536));
  input.close();
});

test('PTY input cancels queued data on a failed descriptor and refuses later input', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const input = new PtyInput(42, () => { calls++; throw Object.assign(new Error('closed'), { code: 'EIO' }); });
  input.write('old input'); t.mock.timers.tick(1); t.mock.timers.tick(100);
  assert.equal(calls, 1); assert.throws(() => input.write('late'), /conflict/);
});


test('PTY input stops before socket destruction can reuse the fd, without waiting for process exit', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let owned = true; let calls = 0;
  const input = new PtyInput(42, (_fd, _buffer, _offset, length) => { calls++; return length; }, () => owned);
  input.write('old input'); owned = false;
  t.mock.timers.tick(1);
  assert.equal(calls, 0); assert.throws(() => input.write('late'), /conflict/);
});

test('PTY input bounds tiny pending entries and syscall work per drain', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const input = new PtyInput(42, () => { calls++; return 1; });
  for (let index = 0; index < 4096; index++) input.write('x');
  assert.throws(() => input.write('x'), /busy/);
  t.mock.timers.tick(1);
  assert.equal(calls, 64);
  input.close(); t.mock.timers.tick(100);
  assert.equal(calls, 64);
});
