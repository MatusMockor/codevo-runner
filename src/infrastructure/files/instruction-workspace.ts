import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isId, RunnerError } from '../../domain/contracts.js';
import { parseInstructionSnapshot, type InstructionSnapshot } from '../../domain/instructions.js';
import { materializedInstructionFiles } from '../../domain/instruction-context.js';

type Hashes = Record<string, string>;
type Manifest = { version: 1; root: string; files: Hashes; pending?: Hashes };
const active = new Set<string>();
const runFile = promisify(execFile);
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const conflict = (): never => { throw new RunnerError('conflict'); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && path.toLowerCase().endsWith('.md') && !/[\\\u0000-\u001f\u007f:]/.test(path) &&
    !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

const descriptorPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
async function openDirectory(path: string): Promise<FileHandle> {
  const expected = await lstat(path);
  if (!expected.isDirectory() || expected.isSymbolicLink()) conflict();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const actual = await handle.stat();
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) { await handle.close(); conflict(); }
  return handle;
}
/** Every component is opened relative to the retained parent, never a checked pathname. */
async function parentHandle(root: FileHandle, path: string, create: boolean): Promise<FileHandle> {
  let current = await open(descriptorPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split('/').slice(0, -1)) {
      const child = `${descriptorPath(current)}/${part}`;
      if (create) {
        try { await mkdir(child, { mode: 0o700 }); await current.sync(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      let next: FileHandle;
      try { next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) { if (missing(error)) throw error; throw new RunnerError('conflict'); }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}
async function readRegular(root: FileHandle, path: string, limit = 8 * 1024 * 1024): Promise<Buffer | undefined> {
  let parent: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    parent = await parentHandle(root, path, false);
    const target = `${descriptorPath(parent)}/${path.split('/').at(-1)!}`;
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) conflict();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) conflict();
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) conflict();
    return buffer.subarray(0, count);
  } catch (error) { if (missing(error)) return undefined; throw error; }
  finally { await handle?.close(); await parent?.close(); }
}
async function fileHash(root: FileHandle, path: string): Promise<string | undefined> {
  const bytes = await readRegular(root, path);
  return bytes === undefined ? undefined : digest(bytes);
}
async function durableWrite(root: FileHandle, path: string, text: string, guard?: { hash: string | undefined; signal: AbortSignal }): Promise<void> {
  const parent = await parentHandle(root, path, true);
  const target = `${descriptorPath(parent)}/${path.split('/').at(-1)!}`;
  const temporary = `${descriptorPath(parent)}/.codevo-sync-${randomUUID()}`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    if (guard) {
      if (await fileHash(parent, path.split('/').at(-1)!) !== guard.hash) conflict();
      guard.signal.throwIfAborted();
    }
    await rename(temporary, target);
    await parent.sync();
  } finally {
    try { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
    finally { await parent.close(); }
  }
}
async function durableRemove(root: FileHandle, path: string, hash: string, signal: AbortSignal): Promise<void> {
  const parent = await parentHandle(root, path, false);
  try {
    if (await fileHash(parent, path.split('/').at(-1)!) !== hash) conflict();
    signal.throwIfAborted();
    await unlink(`${descriptorPath(parent)}/${path.split('/').at(-1)!}`); await parent.sync();
  }
  finally { await parent.close(); }
}
async function pristineTracked(root: string, path: string, hash: string, signal: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await runFile('git', ['--no-pager', 'show', `HEAD:${path}`], {
      cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 5000, signal,
    });
    signal.throwIfAborted();
    return digest(stdout) === hash;
  } catch { signal.throwIfAborted(); return false; }
}
function parseManifest(value: unknown, root: string): Manifest {
  if (!value || typeof value !== 'object') return conflict();
  const data = value as Manifest;
  if (data.version !== 1 || data.root !== root) return conflict();
  if (!data.files) return conflict();
  for (const hashes of [data.files, ...(data.pending === undefined ? [] : [data.pending])]) {
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.keys(hashes).length > 2048) return conflict();
    for (const [path, hash] of Object.entries(hashes)) {
      if (!safePath(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return conflict();
    }
  }
  return data;
}

/** Reconciles only Codevo-owned instruction files; edits on the server fail closed. */
export class FileInstructionWorkspace {
  constructor(private readonly dataDir: string) {}

  async apply(workspaceTaskId: string, cwd: string, snapshot: InstructionSnapshot, signal: AbortSignal, isolation: 'in-place' | 'worktree' = 'worktree', expectedIdentity?: Readonly<{ dev: number; ino: number }>): Promise<void> {
    signal.throwIfAborted();
    if (isolation !== 'in-place' && isolation !== 'worktree') throw new RunnerError('invalid_input');
    snapshot = parseInstructionSnapshot(snapshot);
    // This adapter cannot materialize rules on these platforms, so an empty shared-checkout
    // reconciliation has no owned state to remove. Keep nonempty requests fail-closed.
    if (process.platform !== 'linux') {
      if (isolation === 'in-place' && snapshot.files.length === 0) return;
      throw new RunnerError('storage_unavailable');
    }
    if (!isId(workspaceTaskId)) throw new RunnerError('invalid_input');
    const root = await realpath(cwd);
    if (resolve(cwd) !== root) conflict();
    const rootIdentity = await lstat(root);
    if (expectedIdentity && (rootIdentity.dev !== expectedIdentity.dev || rootIdentity.ino !== expectedIdentity.ino)) conflict();
    if (active.has(root)) throw new RunnerError('busy');
    active.add(root);
    let workspace: FileHandle | undefined;
    let storage: FileHandle | undefined;
    let manifests: FileHandle | undefined;
    try {
      workspace = await openDirectory(root);
      const openedRoot = await workspace.stat();
      if (openedRoot.dev !== rootIdentity.dev || openedRoot.ino !== rootIdentity.ino) conflict();
      const contents = new Map<string, string>();
      for (const file of materializedInstructionFiles(snapshot)) {
        if (!safePath(file.path) || contents.has(file.path)) throw new RunnerError('invalid_input');
        contents.set(file.path, file.content);
      }
      const next = Object.fromEntries([...contents].map(([path, content]) => [path, digest(content)]));
      const dataRoot = await realpath(this.dataDir);
      if (dataRoot === root || dataRoot.startsWith(root + sep)) conflict();
      storage = await openDirectory(dataRoot);
      manifests = await parentHandle(storage, 'instruction-manifests/entry', true);
      // Shared checkouts share ownership across conversations, but never across root replacement.
      const manifestPath = isolation === 'in-place'
        ? `checkout-${digest(JSON.stringify([root, String(openedRoot.dev), String(openedRoot.ino)]))}.json`
        : `${workspaceTaskId}.json`;
      let previous: Manifest = { version: 1, root, files: {} };
      const manifestBytes = await readRegular(manifests, manifestPath, 256 * 1024);
      if (manifestBytes !== undefined) previous = parseManifest(JSON.parse(manifestBytes.toString('utf8')), root);
      const all = new Set([...Object.keys(previous.files), ...Object.keys(previous.pending ?? {}), ...contents.keys()]);
      const observed = new Map<string, string | undefined>();
      const borrowed = new Set<string>();
      for (const path of all) {
        signal.throwIfAborted();
        const current = await fileHash(workspace, path);
        const owned = Object.hasOwn(previous.files, path) || Object.hasOwn(previous.pending ?? {}, path);
        if (owned) {
          if (current !== previous.files[path] && (previous.pending === undefined || current !== previous.pending[path])) conflict();
        } else if (current !== undefined) {
          if (current !== next[path] && (isolation === 'in-place' || !await pristineTracked(root, path, current, signal))) conflict();
          // Identical user files are usable, but must never become ours to remove or overwrite.
          if (isolation === 'in-place') borrowed.add(path);
        }
        observed.set(path, current);
      }
      signal.throwIfAborted();
      // The durable journal permits only exact old/new bytes after interruption.
      const baseline = Object.fromEntries([...observed].filter((entry): entry is [string, string] => entry[1] !== undefined && !borrowed.has(entry[0])));
      const managedNext = Object.fromEntries(Object.entries(next).filter(([path]) => !borrowed.has(path)));
      await durableWrite(manifests, manifestPath, JSON.stringify({ version: 1, root, files: baseline, pending: managedNext }));
      for (const path of all) {
        signal.throwIfAborted();
        const identity = await lstat(root);
        if (identity.dev !== rootIdentity.dev || identity.ino !== rootIdentity.ino ||
            await realpath(cwd) !== root || await fileHash(workspace, path) !== observed.get(path)) conflict();
        signal.throwIfAborted();
        const content = contents.get(path);
        if (content === undefined) {
          if (observed.get(path) !== undefined) {
            await durableRemove(workspace, path, observed.get(path)!, signal);
          }
        } else if (observed.get(path) !== next[path]) await durableWrite(workspace, path, content, { hash: observed.get(path), signal });
      }
      for (const path of all) {
        signal.throwIfAborted();
        if (await fileHash(workspace, path) !== next[path]) conflict();
      }
      signal.throwIfAborted();
      const finalIdentity = await lstat(cwd);
      if (finalIdentity.dev !== rootIdentity.dev || finalIdentity.ino !== rootIdentity.ino ||
          await realpath(cwd) !== root) conflict();
      await durableWrite(manifests, manifestPath, JSON.stringify({ version: 1, root, files: managedNext }));
      const committedIdentity = await lstat(cwd);
      if (committedIdentity.dev !== rootIdentity.dev || committedIdentity.ino !== rootIdentity.ino ||
          await realpath(cwd) !== root) conflict();
      signal.throwIfAborted();
    } finally {
      try { await manifests?.close(); }
      finally {
        try { await storage?.close(); }
        finally { try { await workspace?.close(); } finally { active.delete(root); } }
      }
    }
  }
}
