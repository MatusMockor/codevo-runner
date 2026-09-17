import { randomUUID } from 'node:crypto';
import { RunnerError, isId } from '../domain/contracts.js';
import { TERMINAL_LIMITS, terminalInput, terminalOpen, terminalSize, type TerminalChunk, type TerminalPage, type TerminalSnapshot } from '../domain/terminal.js';
import type { SurfaceWorkspace, SurfaceWorkspaceResolver } from './surface-workspace.js';
import type { TerminalProcess, TerminalProcessFactory } from './terminal-ports.js';
type Session = { snapshot: TerminalSnapshot; chunks: TerminalChunk[]; bytes: number; touched: number; inputWindow: number; inputBytes: number; workspace: SurfaceWorkspace; process?: TerminalProcess };
/** A primary PTY per exact project/task survives transport reconnects, with bounded replay. */
export class TerminalService {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<TerminalSnapshot>>();
  private closed = false;
  private readonly expiry = setInterval(() => this.expire(), 60_000).unref();
  constructor(private readonly resolver: SurfaceWorkspaceResolver, private readonly factory: TerminalProcessFactory) {}
  open(projectId: string, value: unknown): Promise<TerminalSnapshot> {
    const input = terminalOpen(value);
    const key = JSON.stringify([projectId, input.taskId ?? null]);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const promise = this.create(projectId, input).finally(() => this.opening.delete(key));
    this.opening.set(key, promise);
    return promise;
  }
  private async create(projectId: string, input: ReturnType<typeof terminalOpen>): Promise<TerminalSnapshot> {
    if (this.closed) throw new RunnerError('storage_unavailable');
    const existing = [...this.sessions.values()].find(session => session.snapshot.projectId === projectId && session.snapshot.taskId === (input.taskId ?? null) && session.snapshot.status === 'running');
    if (existing) { await this.authorize(existing); return existing.snapshot; }
    this.expire();
    if (this.sessions.size + this.opening.size >= TERMINAL_LIMITS.sessions) throw new RunnerError('busy');
    const workspace = await this.resolver.resolve(projectId, input.taskId);
    if (this.closed) throw new RunnerError('storage_unavailable');
    const session: Session = { snapshot: { id: randomUUID(), projectId, taskId: input.taskId ?? null, cols: input.cols, rows: input.rows, status: 'running', exitCode: null, sequence: 0 }, chunks: [], bytes: 0, touched: Date.now(), inputWindow: Date.now(), inputBytes: 0, workspace };
    this.sessions.set(session.snapshot.id, session);
    try {
      await workspace.revalidate();
      if (this.closed) throw new RunnerError('storage_unavailable');
      const process = await this.factory.open(workspace, input, data => this.append(session, data), exitCode => { session.snapshot = { ...session.snapshot, status: 'exited', exitCode }; });
      session.process = process;
      await workspace.revalidate();
      if (this.closed || !this.sessions.has(session.snapshot.id)) { process.close(); throw new RunnerError('storage_unavailable'); }
      return session.snapshot;
    } catch (error) { this.remove(session); throw error; }
  }
  private append(session: Session, data: string): void {
    if (this.closed || this.sessions.get(session.snapshot.id) !== session) return;
    // Each chunk is UTF-8 safe and capped, including pathological provider bursts.
    let chunk = ''; let bytes = 0;
    const commit = () => {
      if (!chunk) return;
      session.snapshot = { ...session.snapshot, sequence: session.snapshot.sequence + 1 };
      session.chunks.push({ sequence: session.snapshot.sequence, data: chunk }); session.bytes += bytes;
      while (session.bytes > TERMINAL_LIMITS.retainedBytes || session.chunks.length > 4096) { const removed = session.chunks.shift()!; session.bytes -= Buffer.byteLength(removed.data); }
      chunk = ''; bytes = 0;
    };
    for (const point of data) { const size = Buffer.byteLength(point); if (bytes + size > 16_384) commit(); chunk += point; bytes += size; }
    commit();
  }
  private session(projectId: string, id: string, taskId?: string): Session {
    if (this.closed || !isId(id)) throw new RunnerError('not_found');
    const session = this.sessions.get(id);
    if (!session || session.snapshot.projectId !== projectId || session.snapshot.taskId !== (taskId ?? null)) throw new RunnerError('not_found');
    return session;
  }
  private async authorize(session: Session): Promise<void> {
    try { await session.workspace.revalidate(); }
    catch (error) { this.remove(session); throw error; }
    if (this.closed || this.sessions.get(session.snapshot.id) !== session) throw new RunnerError('not_found');
    session.touched = Date.now();
  }
  async read(projectId: string, id: string, after: number, taskId?: string): Promise<TerminalPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new RunnerError('invalid_input');
    const session = this.session(projectId, id, taskId); await this.authorize(session);
    if (after > session.snapshot.sequence) throw new RunnerError('invalid_input');
    let bytes = 0; const chunks: TerminalChunk[] = [];
    for (const chunk of session.chunks) { if (chunk.sequence <= after) continue; const size = Buffer.byteLength(chunk.data); if (bytes + size > TERMINAL_LIMITS.pageBytes) break; chunks.push(chunk); bytes += size; }
    return { ...session.snapshot, chunks, truncated: after < (session.chunks[0]?.sequence ?? 1) - 1 };
  }
  async input(projectId: string, id: string, value: unknown, taskId?: string): Promise<Readonly<{ accepted: true }>> {
    const data = terminalInput(value); const session = this.session(projectId, id, taskId); await this.authorize(session);
    if (session.snapshot.status !== 'running') throw new RunnerError('conflict');
    if (Date.now() - session.inputWindow >= 1000) { session.inputWindow = Date.now(); session.inputBytes = 0; }
    if (session.inputBytes + Buffer.byteLength(data) > 262_144) throw new RunnerError('busy');
    session.inputBytes += Buffer.byteLength(data);
    session.process!.write(data); return { accepted: true };
  }
  async resize(projectId: string, id: string, value: unknown, taskId?: string): Promise<TerminalSnapshot> {
    const size = terminalSize(value); const session = this.session(projectId, id, taskId); await this.authorize(session);
    if (session.snapshot.status !== 'running') throw new RunnerError('conflict');
    session.process!.resize(size); session.snapshot = { ...session.snapshot, ...size }; return session.snapshot;
  }
  closeSession(projectId: string, id: string, taskId?: string): Readonly<{ closed: true }> { this.remove(this.session(projectId, id, taskId)); return { closed: true }; }
  private remove(session: Session): void { this.sessions.delete(session.snapshot.id); try { session.process?.close(); } catch { /* Continue releasing all owned sessions if an OS cleanup fails. */ } }
  private expire(): void { for (const session of this.sessions.values()) if (Date.now() - session.touched > TERMINAL_LIMITS.idleMs) this.remove(session); }
  async close(): Promise<void> { this.closed = true; clearInterval(this.expiry); for (const session of this.sessions.values()) this.remove(session); await Promise.allSettled(this.opening.values()); }
}
