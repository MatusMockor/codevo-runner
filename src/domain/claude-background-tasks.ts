/** Invocation-owned liveness from provider lifecycle events, never assistant prose. */
export class ClaudeBackgroundTasks {
  private readonly live = new Set<string>();
  private readonly terminal = new Set<string>();
  get active(): boolean { return this.live.size > 0; }

  observe(frame: Readonly<Record<string, unknown>>, sessionId: string | undefined): void {
    if (frame.type !== 'system' || !['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(String(frame.subtype))) return;
    if (frame.parent_tool_use_id !== undefined && frame.parent_tool_use_id !== null) return;
    if (!sessionId || (frame.session_id !== undefined && frame.session_id !== sessionId)) throw new Error('session_mismatch');
    const id = frame.task_id;
    if (typeof id !== 'string' || !id.trim() || new TextEncoder().encode(id).length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error('invalid_background_task');
    const patch = frame.patch;
    const status = frame.subtype === 'task_updated' && patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>).status : frame.status;
    const ended = ['completed', 'failed', 'killed', 'cancelled', 'stopped', 'interrupted'].includes(String(status));
    if (ended || ['plan', 'dream'].includes(String(frame.task_type))) {
      if (!this.terminal.has(id) && this.terminal.size >= 4096) throw new Error('background_task_limit');
      this.live.delete(id); this.terminal.add(id); return;
    }
    // Only a real start creates ownership. Late progress and duplicate starts cannot revive it.
    if (frame.subtype !== 'task_started' || this.terminal.has(id)) return;
    if (!this.live.has(id) && this.live.size >= 256) throw new Error('background_task_limit');
    this.live.add(id);
  }
}
