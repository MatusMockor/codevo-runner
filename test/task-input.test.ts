import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseTaskInput } from '../src/domain/task-input.js';
import { LIMITS, RunnerError } from '../src/domain/contracts.js';

test('oversized prompt text reports too_large for character and aggregate UTF-8 limits', () => {
  const inputs = [
    [{ type: 'text', text: 'a'.repeat(LIMITS.textBytes + 1) }],
    [{ type: 'text', text: 'é'.repeat(LIMITS.textBytes / 2 + 1) }],
    [{ type: 'text', text: 'a'.repeat(24_001) }, { type: 'text', text: 'b'.repeat(24_000) }],
  ];
  for (const parts of inputs) assert.throws(
    () => parseTaskInput({ idempotencyKey: randomUUID(), provider: 'codex', parts }),
    error => error instanceof RunnerError && error.code === 'too_large',
  );
  const valid = parseTaskInput({ idempotencyKey: randomUUID(), provider: 'codex',
    parts: [{ type: 'text', text: 'a'.repeat(LIMITS.textBytes) }] });
  assert.equal(valid.parts.length, 1);
});
