import type { AccountUsageReader } from '../../application/account-usage-service.js';
import { parseClaudeUsage, parseCodexUsage, validateAccountUsage, type AccountUsageProvider, type AccountUsageSnapshot } from '../../domain/account-usage.js';
import { runUsageProcess, type UsageProcessOptions } from './account-usage-process.js';
import { claudeUsageIdentity, codexUsageIdentity } from './account-usage-identity.js';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class CliAccountUsageReader implements AccountUsageReader {
  constructor(private readonly options: UsageProcessOptions = {}) {}
  async read(provider: AccountUsageProvider, signal: AbortSignal): Promise<AccountUsageSnapshot> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(10_000, Math.max(1, this.options.timeoutMs ?? 10_000)));
    const ownedSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      const snapshot = provider === 'claudeCode' ? await this.claude(ownedSignal) : await this.codex(ownedSignal);
      ownedSignal.throwIfAborted();
      return validateAccountUsage({ provider, fetchedAtEpochMs: Date.now(), ...snapshot });
    } finally { clearTimeout(timer); }
  }

  private async claude(signal: AbortSignal) {
    const executable = this.options.claudeExecutable ?? 'claude';
    const before = await this.claudeIdentity(executable, signal);
    const output = await runUsageProcess(executable,
      ['--safe-mode', '--tools', '', '-p', '/usage', '--output-format', 'json', '--permission-mode', 'dontAsk', '--no-session-persistence'],
      { initialInput: '' }, signal, this.options.timeoutMs);
    const after = await this.claudeIdentity(executable, signal);
    return { windows: parseClaudeUsage(output), accountIdentity: before !== null && before === after ? before : null };
  }

  private async claudeIdentity(executable: string, signal: AbortSignal): Promise<string | null> {
    try {
      const output = await runUsageProcess(executable, ['auth', 'status', '--json'], { initialInput: '' }, signal, this.options.timeoutMs);
      return claudeUsageIdentity(JSON.parse(output));
    } catch { signal.throwIfAborted(); return null; }
  }

  private async codex(signal: AbortSignal) {
    let expected = 0;
    const seen = new Set<number>();
    let usage: unknown;
    let before: unknown, after: unknown;
    await runUsageProcess(this.options.codexExecutable ?? 'codex', ['app-server', '--stdio'], {
      initialInput: JSON.stringify({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codevo-runner', title: 'Codevo Runner', version: '0.1.0' } } }) + '\n',
      onLine: (line, write) => {
        if (!line.trim()) return false;
        const message = record(JSON.parse(line));
        if (!message || message.id === undefined) return false;
        if (typeof message.id !== 'number' || message.id !== expected || seen.has(message.id)) throw new Error('usage_unavailable');
        seen.add(message.id);
        if (expected === 0) {
          if (!('result' in message) || 'error' in message) throw new Error('usage_unavailable');
          write({ method: 'initialized', params: {} });
          expected = 2;
          write({ id: 2, method: 'account/read', params: { refreshToken: false } });
          return false;
        }
        if (expected === 2) {
          before = 'error' in message ? undefined : message.result;
          expected = 1;
          write({ id: 1, method: 'account/rateLimits/read', params: {} });
          return false;
        }
        if (expected === 1) {
          if (!('result' in message) || 'error' in message) throw new Error('usage_unavailable');
          usage = message.result;
          expected = 3;
          write({ id: 3, method: 'account/read', params: { refreshToken: false } });
          return false;
        }
        after = 'error' in message ? undefined : message.result;
        return true;
      },
    }, signal, this.options.timeoutMs);
    return { windows: parseCodexUsage(usage), accountIdentity: codexUsageIdentity(before, usage, after) };
  }
}
