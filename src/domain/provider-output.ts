/** Bounded parser for the structured stdout contract of supported provider CLIs. */
export function isProviderSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type ProviderOutputResult = Readonly<{ sessionId?: string; error?: string }>;
const encoder = new TextEncoder();
const MAX_LINE_BYTES = 65_536;

export class ProviderOutputParser {
  private pending = '';
  private sessionId?: string;
  private error?: string;
  private succeeded = false;
  private finished = false;

  constructor(private readonly provider: 'codex' | 'claude', private readonly expectedSessionId?: string) {
    if (expectedSessionId !== undefined && !isProviderSessionId(expectedSessionId)) this.error = 'provider_session_invalid';
  }

  push(text: string): void {
    if (this.finished || this.error) return;
    // Scan chunks without building an unbounded array of lines.
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      if (end - offset > MAX_LINE_BYTES) {
        this.error = 'provider_output_limit_exceeded'; this.pending = ''; return;
      }
      const fragment = text.slice(offset, end);
      if (encoder.encode(this.pending).byteLength + encoder.encode(fragment).byteLength > MAX_LINE_BYTES) {
        this.error = 'provider_output_limit_exceeded'; this.pending = ''; return;
      }
      this.pending += fragment;
      if (newline < 0) return;
      this.parseLine(this.pending);
      this.pending = '';
      if (this.error) return;
      offset = newline + 1;
    }
  }

  currentSessionId(): string | undefined {
    if (this.error && this.error !== 'provider_reported_failure') return undefined;
    return this.sessionId;
  }

  finish(): ProviderOutputResult {
    if (!this.finished && !this.error && this.pending.trim()) this.parseLine(this.pending);
    this.pending = '';
    this.finished = true;
    if (this.error) return { ...(this.error === 'provider_reported_failure' && this.sessionId ? { sessionId: this.sessionId } : {}), error: this.error };
    if (!this.sessionId) return { error: 'provider_session_missing' };
    if (!this.succeeded) return { sessionId: this.sessionId, error: 'provider_result_missing' };
    return { sessionId: this.sessionId };
  }

  private acceptSession(value: unknown): void {
    if (!isProviderSessionId(value)) { this.error = 'provider_session_invalid'; return; }
    if ((this.sessionId && this.sessionId !== value) || (this.expectedSessionId && this.expectedSessionId !== value)) {
      this.error = 'provider_session_mismatch'; return;
    }
    this.sessionId = value;
  }

  private parseLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.error = 'provider_output_invalid'; return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.error = 'provider_output_invalid'; return; }
    const event = value as Record<string, unknown>;
    if (typeof event.type !== 'string') { this.error = 'provider_output_invalid'; return; }
    if (this.provider === 'codex') {
      if (event.type === 'thread.started') this.acceptSession(event.thread_id);
      if (event.type === 'turn.completed') this.succeeded = true;
      if (event.type === 'turn.failed' || event.type === 'error') this.error = 'provider_reported_failure';
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') this.acceptSession(event.session_id);
    if (event.type === 'result') {
      if (!this.sessionId) { this.error = 'provider_session_missing'; return; }
      this.acceptSession(event.session_id);
      if (this.error) return;
      if (event.is_error !== false || event.subtype !== 'success') { this.error = 'provider_reported_failure'; return; }
      this.succeeded = true;
    }
  }
}
