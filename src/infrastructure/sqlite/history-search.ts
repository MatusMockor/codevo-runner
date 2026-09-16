import { outputRetentionMetadata } from './output-retention.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '../../domain/contracts.js';
import { parseHistorySearch, type HistorySearchPage, type HistorySearchQuery, type HistorySearchMatch } from '../../domain/history-search.js';

/** A page scans at most ten retained tasks; even an empty match page can have a cursor. */
export function searchHistory(db: DatabaseSync, input: HistorySearchQuery): HistorySearchPage {
  const query = parseHistorySearch(input);
  const rows = db.prepare('SELECT sequence,payload FROM tasks WHERE sequence>? ORDER BY sequence LIMIT 11').all(query.after);
  const items: HistorySearchMatch[] = [];
  let incomplete = false;
  for (const row of rows.slice(0, 10)) {
    const task = JSON.parse(row['payload'] as string) as Task;
    if (query.projectId !== undefined && task.projectId !== query.projectId) continue;
    const base = { taskId: task.id, conversationId: task.conversationId ?? task.id, projectId: task.projectId ?? null, taskSequence: Number(row['sequence']) };
    const user = task.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    const userSnippet = snippet(user, query.q);
    if (userSnippet !== null) items.push({ ...base, role: 'user', eventSequence: null, snippet: userSnippet });
    const retention = outputRetentionMetadata(db, task.id);
    if (retention.outputTruncatedBeforeSequence) incomplete = true;
    let skipPartial = retention.outputStartsAtLineBoundary === false;
    const events = db.prepare("SELECT sequence,data FROM events WHERE task_id=? AND type='task.output' ORDER BY sequence LIMIT 1025").all(task.id);
    if (events.length > 1024) incomplete = true;
    let pending = ''; let lineSequence = 0; let matched = false; let stdoutBytes = 0;
    const inspect = (line: string, sequence: number) => {
      if (!line.trim()) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { incomplete = true; return; }
      if (matched) return;
      const texts = assistantText(value, task.provider);
      for (const text of texts) {
        const found = snippet(text, query.q);
        if (found !== null && !matched) { items.push({ ...base, role: 'assistant', eventSequence: sequence, snippet: found }); matched = true; }
      }
    };
    for (const event of events.slice(0, 1024)) {
      const data = JSON.parse(event['data'] as string) as { channel?: string; text?: string };
      if (data.channel !== 'stdout' || typeof data.text !== 'string') continue;
      stdoutBytes += Buffer.byteLength(data.text);
      if (stdoutBytes > 1_048_576) { incomplete = true; pending = ''; break; }
      if (!pending) lineSequence = Number(event['sequence']);
      let text = data.text;
      if (skipPartial) {
        const newline = text.indexOf('\n');
        if (newline < 0) continue;
        text = text.slice(newline + 1);
        skipPartial = false;
      }
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        inspect(pending.slice(0, newline), lineSequence);
        pending = pending.slice(newline + 1); lineSequence = Number(event['sequence']);
      }
    }
    if (pending) inspect(pending, lineSequence);
  }
  return { items, nextCursor: rows.length > 10 ? Number(rows[9]!['sequence']) : null, scope: 'retained_runner_history', incomplete };
}
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function assistantText(value: unknown, provider: Task['provider']): string[] {
  const event = record(value); if (!event) return [];
  if (provider === 'codex') {
    const item = record(event.item);
    return event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string' ? [item.text] : [];
  }
  if (event.type === 'result' && typeof event.result === 'string') return [event.result];
  const message = record(event.message);
  if (event.type !== 'assistant' || !Array.isArray(message?.content)) return [];
  return message.content.flatMap((part: unknown) => { const p = record(part); return p?.type === 'text' && typeof p.text === 'string' ? [p.text] : []; });
}
function snippet(text: string, query: string): string | null {
  const foldedIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (foldedIndex < 0) return null;
  // Unicode lowercase can expand (İ → i + combining dot), so map back before slicing.
  let index = 0; let foldedOffset = 0;
  for (const character of text) {
    if (foldedOffset >= foldedIndex) break;
    foldedOffset += character.toLowerCase().length; index += character.length;
  }
  // Code point slicing keeps snippets valid Unicode, including supplementary characters.
  const before = Array.from(text.slice(0, index));
  const suffix = Array.from(text.slice(index));
  return (before.length > 60 ? '…' : '') + before.slice(-60).join('').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '�') + suffix.slice(0, 320).join('').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '�') + (suffix.length > 320 ? '…' : '');
}
