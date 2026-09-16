/** Finite wall-clock budget for one provider invocation, including user input waits. */
export const MIN_EXECUTION_TIMEOUT_MS = 60_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const MAX_EXECUTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export function executionTimeoutMs(value: number = DEFAULT_EXECUTION_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value < MIN_EXECUTION_TIMEOUT_MS || value > MAX_EXECUTION_TIMEOUT_MS)
    throw new Error('CODEVO_EXECUTION_TIMEOUT_MS must be an integer between 60000 and 604800000');
  return value;
}

export function parseExecutionTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EXECUTION_TIMEOUT_MS;
  if (!/^[0-9]{1,9}$/.test(value))
    throw new Error('CODEVO_EXECUTION_TIMEOUT_MS must be an integer between 60000 and 604800000');
  return executionTimeoutMs(Number(value));
}
