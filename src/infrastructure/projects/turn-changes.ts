import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isId, RunnerError } from '../../domain/contracts.js';
import { validateWorkspacePath } from '../../domain/workspace-files.js';
import type { TurnChangedFile, TurnChangesSummary, TurnFileDiff } from '../../domain/turn-changes.js';
import type { TurnChanges } from '../../application/turn-changes.js';
import { validStoredTurn } from './turn-changes-codec.js';
import { runTurnHelper, type CapturedFile, type TurnSnapshot } from './turn-capture-helper.js';

type Identity = Readonly<{ dev: number; ino: number }>;
type Start = Readonly<{ cwd: string; identity: Identity; snapshot: TurnSnapshot }>;
type Complete = Readonly<{ summary: TurnChangesSummary; diffs: readonly TurnFileDiff[] }>;
const RECORD_BYTES = 24 * 1024 * 1024;
const QUOTA_BYTES = 256 * 1024 * 1024;
const unavailable = (turnId: string, reason = 'A complete snapshot of this turn is unavailable.'): TurnChangesSummary =>
  ({ turnId, state: 'unavailable', files: [], truncated: false, reason });

/** Durable, immutable before/after snapshots; never consult HEAD or a later worktree. */
export class FileTurnChangesStore implements TurnChanges {
  private readonly root: string;
  private serial: Promise<void> = Promise.resolve();
  private pending = 0;
  private rootIdentity?: Identity;
  constructor(dataDir: string) { this.root = join(dataDir, 'turn-changes'); }
  private id(id: string) {
    if (!isId(id) || id.length !== 36) throw new RunnerError('invalid_input');
    return id;
  }
  private async owned<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 4) throw new RunnerError('busy');
    this.pending++;
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { this.pending--; release(); }
  }
  private async withRoot<T>(operation: (base: string) => Promise<T>, synchronize = false): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const identity = await handle.stat();
      if (this.rootIdentity && (identity.dev !== this.rootIdentity.dev || identity.ino !== this.rootIdentity.ino)) throw new RunnerError('conflict');
      this.rootIdentity = { dev: identity.dev, ino: identity.ino };
      const base = process.platform === 'linux' ? `/proc/${process.pid}/fd/${handle.fd}` : this.root;
      const check = async () => {
        const current = await lstat(this.root);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new RunnerError('conflict');
      };
      await check();
      const result = await operation(base);
      await check();
      if (synchronize) await handle.sync();
      return result;
    } finally { await handle.close(); }
  }
  private async read<T>(name: string): Promise<T | null> {
    return this.withRoot(async base => {
    const handle = await open(join(base, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) return null;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > RECORD_BYTES) return null;
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== info.size) return null;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      return validStoredTurn(value, name.slice(0,36), name.endsWith('.start')) ? value as T : null;
    } catch { return null; } finally { await handle.close(); }
    }).catch(() => null);
  }
  private async write(name: string, value: unknown, signal?: AbortSignal) {
    return this.withRoot(async base => {

    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > RECORD_BYTES) throw new RunnerError('quota_exceeded');
    let total = 0; let count = 0;
    const directory = await opendir(base);
    for await (const item of directory) {
      if (++count >= 1024) throw new RunnerError('quota_exceeded');
      const info = await lstat(join(base, item.name));
      if (!info.isFile() || info.isSymbolicLink()) throw new RunnerError('storage_unavailable');
      total += info.size;
    }
    if (total + bytes.length > QUOTA_BYTES) throw new RunnerError('quota_exceeded');
    const temporary = join(base, `${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); signal?.throwIfAborted(); await link(temporary, join(base, name)); }
    finally { await handle.close(); await unlink(temporary).catch(() => undefined); }
    }, true);
  }
  async captureStart(taskId: string, cwd: string, identity: Identity, signal: AbortSignal): Promise<void> {
    this.id(taskId);
    await this.owned(async () => {
      if (await this.read(`${taskId}.start`) || await this.read(`${taskId}.end`)) return;
      try {
        signal.throwIfAborted();
        const snapshot = await runTurnHelper({ mode: 'capture', cwd, identity }, signal) as TurnSnapshot;
        signal.throwIfAborted();
        await this.write(`${taskId}.start`, { cwd, identity, snapshot }, signal);
      } catch {
        await this.write(`${taskId}.end`, { summary: unavailable(taskId), diffs: [] }).catch(() => undefined);
      }
    });
  }
  async captureEnd(taskId: string, cwd: string, identity: Identity, signal: AbortSignal): Promise<void> {
    this.id(taskId);
    await this.owned(async () => {
      if (await this.read(`${taskId}.end`)) return;
      const start = await this.read<Start>(`${taskId}.start`);
      try {
        if (!start || start.cwd !== cwd || start.identity.dev !== identity.dev || start.identity.ino !== identity.ino) throw new Error('missing baseline');
        signal.throwIfAborted();
        const end = await runTurnHelper({ mode: 'capture', cwd, identity, baselinePaths: start.snapshot.files.map(file => file.path) }, signal) as TurnSnapshot;
        const result = await compare(taskId, start.snapshot, end, signal);
        signal.throwIfAborted();
        await this.write(`${taskId}.end`, result, signal);
        await this.withRoot(base => unlink(join(base, `${taskId}.start`))).catch(() => undefined);
      } catch {
        await this.write(`${taskId}.end`, { summary: unavailable(taskId), diffs: [] }).catch(() => undefined);
      }
    });
  }
  async summary(taskId: string): Promise<TurnChangesSummary> {
    this.id(taskId);
    const value = await this.read<Complete>(`${taskId}.end`);
    return value?.summary?.turnId === taskId ? value.summary : unavailable(taskId);
  }
  async diff(taskId: string, relativePath: string): Promise<TurnFileDiff> {
    this.id(taskId); validateWorkspacePath(relativePath);
    if (relativePath.includes(':') || relativePath.split('/').length > 64 || /[\x7f-\x9f]/.test(relativePath)) throw new RunnerError('invalid_input');
    const value = await this.read<Complete>(`${taskId}.end`);
    const found = value?.summary?.turnId === taskId && value.summary.state === 'ready' && value.diffs.find(item => item.relativePath === relativePath);
    if (!found) throw new RunnerError('not_found');
    return found;
  }
}

async function compare(taskId: string, before: TurnSnapshot, after: TurnSnapshot, signal: AbortSignal): Promise<Complete> {
  const old = new Map(before.files.map(file => [file.path, file]));
  const current = new Map(after.files.map(file => [file.path, file]));
  const changed = [...new Set([...old.keys(), ...current.keys()])].sort().filter(path => old.get(path)?.hash !== current.get(path)?.hash || old.get(path)?.executable !== current.get(path)?.executable);
  const files: TurnChangedFile[] = [];
  const diffs: TurnFileDiff[] = [];
  const pairs: { original: string; modified: string }[] = [];
  const countIndexes: number[] = [];
  const removedByHash = new Map<string, CapturedFile[]>();
  for (const path of changed) {
    const file = old.get(path);
    if (file && !current.has(path)) removedByHash.set(file.hash, [...(removedByHash.get(file.hash) ?? []), file]);
  }
  const renames = new Map<string, CapturedFile>();
  const consumed = new Set<string>();
  for (const path of changed) {
    const file = current.get(path);
    const original = file && !old.has(path) ? removedByHash.get(file.hash)?.shift() : undefined;
    if (original) { renames.set(path, original); consumed.add(original.path); }
  }
  const visible = changed.filter(path => !consumed.has(path));
  for (const path of visible.slice(0, 500)) {
    const original = renames.get(path) ?? old.get(path);
    const modified = current.get(path);
    const unavailableReason = original?.unavailable === 'large' || modified?.unavailable === 'large' ? 'large' : original?.unavailable ?? modified?.unavailable ?? null;
    const index = files.length;
    files.push({ relativePath: path, oldRelativePath: renames.get(path)?.path ?? null,
      status: renames.has(path) ? 'renamed' : !original ? 'added' : !modified ? 'deleted' : 'modified', addedLines: null, deletedLines: null });
    diffs.push({ relativePath: path, original: { text: original?.text ?? '', truncated: original?.unavailable === 'large' },
      modified: { text: modified?.text ?? '', truncated: modified?.unavailable === 'large' }, unavailableReason });
    if (!unavailableReason) { countIndexes.push(index); pairs.push({ original: original?.text ?? '', modified: modified?.text ?? '' }); }
  }
  if (pairs.length) {
    const result = await runTurnHelper({ mode: 'counts', pairs }, signal) as { counts: [number, number][] };
    if (!Array.isArray(result.counts) || result.counts.length !== pairs.length) throw new Error('invalid counts');
    for (let i = 0; i < countIndexes.length; i++) {
      const index = countIndexes[i]!; const counts = result.counts[i]!;
      if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid count');
      files[index] = { ...files[index]!, addedLines: counts[0], deletedLines: counts[1] };
    }
  }
  return { summary: { turnId: taskId, state: 'ready', files, truncated: visible.length > 500, reason: visible.length > 500 ? 'Only the first 500 changed files are shown.' : null }, diffs };
}
