import { ARTIFACT_LIMITS, artifactMediaType, parseArtifactPath } from './artifact.js';

const LINE_BYTES = 256 * 1024;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only completed assistant text can nominate workspace files for capture. */
export class ProviderArtifactReferences {
  private pending = '';
  private droppingLine = false;
  private incomplete = false;
  private stopped = false;
  private finished = false;
  private readonly paths = new Set<string>();
  constructor(private readonly provider: 'codex' | 'claude') {}

  push(stdout: string): void {
    if (this.stopped || this.finished) return;
    let offset = 0;
    while (offset < stdout.length) {
      const newline = stdout.indexOf('\n', offset);
      const end = newline < 0 ? stdout.length : newline;
      // Discard only the oversized frame; a later assistant frame can still
      // nominate an artifact. Check character length before allocating bytes.
      if (!this.droppingLine) {
        if (end - offset > LINE_BYTES || Buffer.byteLength(this.pending) + Buffer.byteLength(stdout.slice(offset, end)) > LINE_BYTES) {
          this.pending = '';
          this.droppingLine = true;
          this.incomplete = true;
        } else {
          this.pending += stdout.slice(offset, end);
        }
      }
      if (newline < 0) break;
      if (!this.droppingLine) this.line(this.pending);
      this.pending = '';
      this.droppingLine = false;
      if (this.stopped) return;
      offset = newline + 1;
    }
  }

  finish(): readonly string[] {
    if (!this.finished && !this.stopped && !this.droppingLine && this.pending) this.line(this.pending);
    this.pending = '';
    this.finished = true;
    return [...this.paths];
  }

  isComplete(): boolean { return !this.stopped && !this.incomplete; }

  private line(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const event = record(parsed);
    if (!event || event.parent_tool_use_id) return;
    if (this.provider === 'codex') {
      const item = record(event.item);
      if (event.type === 'item.completed' && item?.type === 'agent_message' && !item.parent_tool_use_id && typeof item.text === 'string') this.text(item.text);
      return;
    }
    const message = record(event.message);
    if (event.type !== 'assistant' || message?.role !== 'assistant' || message.parent_tool_use_id || !Array.isArray(message.content)) return;
    for (const value of message.content) {
      const block = record(value);
      if (block?.type === 'text' && typeof block.text === 'string') this.text(block.text);
    }
  }

  private text(text: string): void {
    const links = /!?\[[^\]\n]{0,1024}\]\([ \t]*(?:<([^>\n]{1,4096})>|([^\s()]{1,4096}))(?:[ \t]+(?:"[^"\n]{0,1024}"|'[^'\n]{0,1024}'))?[ \t]*\)/g;
    const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, '').replace(/\\([\\`*{}\[\]()#+.!_>-])/g, (_match, punctuation: string) => encodeURIComponent(punctuation).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16)}`));
    for (const match of prose.matchAll(links)) {
      if (this.paths.size >= ARTIFACT_LIMITS.perTask) { this.stopped = true; return; }
      const reference = match[1] ?? match[2];
      if (!reference || reference.startsWith('//') || /[?#]/.test(reference)) continue;
      try { const path = decodeURIComponent(reference); parseArtifactPath({ path }); artifactMediaType(path); this.paths.add(path); } catch { /* Unsupported references are not artifact capabilities. */ }
    }
  }
}
