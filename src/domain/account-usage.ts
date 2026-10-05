export type AccountUsageProvider = 'claudeCode' | 'codex';
export type AccountUsageWindow = Readonly<{
  id: string; label: string; usedPercent: number; windowDurationMinutes: number | null;
  resetsAtEpochMs: number | null; resetsLabel: string | null;
}>;
export type AccountUsageSnapshot = Readonly<{
  provider: AccountUsageProvider; fetchedAtEpochMs: number;
  windows: readonly AccountUsageWindow[]; accountIdentity?: string | null;
}>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_usage');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > maximum || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('invalid_usage');
  return value;
}
function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_usage');
  return value;
}

/** Validate the closed outbound contract, independently of provider output parsing. */
export function validateAccountUsage(value: unknown): AccountUsageSnapshot {
  const row = object(value);
  if (Object.keys(row).some(key => !['provider', 'fetchedAtEpochMs', 'windows', 'accountIdentity'].includes(key)) ||
      !(row.provider === 'claudeCode' || row.provider === 'codex') || nullableInteger(row.fetchedAtEpochMs) === null ||
      !Array.isArray(row.windows) || row.windows.length < 1 || row.windows.length > 12 ||
      !(row.accountIdentity === undefined || row.accountIdentity === null || (typeof row.accountIdentity === 'string' && /^account:v1:sha256:[a-f0-9]{64}$/.test(row.accountIdentity)))) throw new Error('invalid_usage');
  const ids = new Set<string>();
  for (const raw of row.windows) {
    const window = object(raw);
    if (Object.keys(window).length !== 6 || Object.keys(window).some(key => !['id', 'label', 'usedPercent', 'windowDurationMinutes', 'resetsAtEpochMs', 'resetsLabel'].includes(key))) throw new Error('invalid_usage');
    const id = text(window.id, 160);
    text(window.label, 160);
    if (ids.has(id) || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) throw new Error('invalid_usage');
    ids.add(id);
    for (const key of ['windowDurationMinutes', 'resetsAtEpochMs']) {
      if (!(key in window) || window[key] === undefined) throw new Error('invalid_usage');
      nullableInteger(window[key]);
    }
    if (window.resetsLabel !== null) text(window.resetsLabel, 200);
  }
  return row as unknown as AccountUsageSnapshot;
}

export function parseClaudeUsage(output: string): readonly AccountUsageWindow[] {
  const result = object(JSON.parse(output)).result;
  if (typeof result !== 'string') throw new Error('invalid_usage');
  const identities: Readonly<Record<string, readonly [string, string, number]>> = {
    'Current session': ['five_hour', '5-hour limit', 300],
    'Current week (all models)': ['seven_day', 'Weekly limit', 10_080],
    'Current week (Fable)': ['seven_day_fable', 'Weekly Fable limit', 10_080],
    'Current week (Opus)': ['seven_day_opus', 'Weekly Opus limit', 10_080],
    'Current week (Sonnet)': ['seven_day_sonnet', 'Weekly Sonnet limit', 10_080],
  };
  const windows: AccountUsageWindow[] = [];
  for (const line of result.split('\n')) {
    const match = /^\s*(Current (?:session|week[^:]*)):\s*([\d.]+)% used · resets (.+)\s*$/.exec(line);
    if (!match) continue;
    const identity = identities[match[1]!];
    if (!identity) continue;
    windows.push({ id: identity[0], label: identity[1], usedPercent: Number(match[2]), windowDurationMinutes: identity[2], resetsAtEpochMs: null, resetsLabel: match[3]!.trim() });
  }
  return windows;
}

export function parseCodexUsage(result: unknown): readonly AccountUsageWindow[] {
  const row = object(result);
  const buckets = row.rateLimitsByLimitId === undefined || row.rateLimitsByLimitId === null ? { codex: row.rateLimits } : object(row.rateLimitsByLimitId);
  const windows: AccountUsageWindow[] = [];
  for (const [id, value] of Object.entries(buckets)) {
    const bucket = object(value);
    const name = bucket.limitName === null || bucket.limitName === undefined ? 'Codex' : text(bucket.limitName, 120);
    for (const kind of ['primary', 'secondary']) {
      if (bucket[kind] === null || bucket[kind] === undefined) continue;
      const window = object(bucket[kind]);
      const duration = nullableInteger(window.windowDurationMins);
      const resets = nullableInteger(window.resetsAt);
      const suffix = duration === 300 ? '5-hour limit' : duration === 10_080 ? 'Weekly limit' : 'Usage limit';
      windows.push({ id: `${id}-${kind}`, label: `${name} · ${suffix}`, usedPercent: window.usedPercent as number,
        windowDurationMinutes: duration, resetsAtEpochMs: resets === null ? null : resets * 1000, resetsLabel: null });
      if (windows.length > 12) throw new Error('invalid_usage');
    }
  }
  return windows;
}
