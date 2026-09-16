import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { DEFAULT_EXECUTION_TIMEOUT_MS, executionTimeoutMs, parseExecutionTimeoutMs } from '../src/domain/execution-policy.js';

test('execution policy defaults to twelve hours and preserves explicit operator deadlines', () => {
  assert.equal(DEFAULT_EXECUTION_TIMEOUT_MS, 43_200_000);
  assert.equal(parseExecutionTimeoutMs(undefined), 43_200_000);
  for (const value of [60_000, 1_800_000, 43_200_000, 86_400_000, 604_800_000]) {
    assert.equal(parseExecutionTimeoutMs(String(value)), value);
    assert.equal(readConfig({ CODEVO_TOKEN_FILE: '/token', CODEVO_EXECUTION_TIMEOUT_MS: String(value) }).executionTimeoutMs, value);
  }
  assert.equal(readConfig({ CODEVO_TOKEN_FILE: '/token' }).executionTimeoutMs, 43_200_000);
});

test('execution policy fails closed on unbounded, malformed and out-of-range settings', () => {
  for (const value of ['', '0', '-1', '59999', '604800001', 'Infinity', 'NaN', '1e8', '60000.5', ' 60000', '60000\n', '99999999999999999999999999']) {
    assert.throws(() => parseExecutionTimeoutMs(value), /CODEVO_EXECUTION_TIMEOUT_MS/);
    assert.throws(() => readConfig({ CODEVO_TOKEN_FILE: '/token', CODEVO_EXECUTION_TIMEOUT_MS: value }));
  }
  for (const value of [NaN, Infinity, -Infinity, 0, 59_999, 604_800_001, 60_000.5]) {
    assert.throws(() => executionTimeoutMs(value));
  }
});
