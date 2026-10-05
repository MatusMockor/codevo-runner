import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { validGitCheckpoint } from './turn-changes-codec.js';
import { runProcess } from '../execution/process-runner.js';

export type DirectoryIdentity = Readonly<{ dev: number; ino: number }>;
export type GitCheckpoint = Readonly<{
  kind: 'git'; cwd: string; identity: DirectoryIdentity;
  gitDir: string; gitIdentity: DirectoryIdentity; commonDir: string; commonIdentity: DirectoryIdentity;
  before: string; after: string | null;
}>;

/** Fixed, descriptor-pinned Git protocol; content and paths never become shell source. */
export async function runTurnGit(input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const scratch = await mkdtemp(join(tmpdir(), 'codevo-turn-git-'));
  try {
  let output = '';
  const execution = await runProcess({ executable: 'python3', args: ['-I', '-S', '-c', HELPER], cwd: '/',
    stdin: JSON.stringify({ ...(input as Record<string, unknown>), scratch }), env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
    signal, timeoutMs: 60_000, outputBytes: 4 * 1024 * 1024,
    onOutput: async (channel, text) => { if (channel === 'stdout') output += text; },
  });
  signal.throwIfAborted();
  if (execution.error || execution.exitCode !== 0) throw new Error('Git checkpoint process failed or exceeded its time/output limit.');
  const result: unknown = JSON.parse(output);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Git checkpoint response.');
  if ('error' in result) throw new Error(checkpointFailureReason(new Error(String((result as { error: unknown }).error))));
  return result;
  } catch (error) {
    const request = input as Record<string, unknown>;
    if (request.mode === 'capture') {
      const journal = await readPublication(scratch);
      if (journal && journal.operation === request.operation) await runTurnGit({ ...request, mode: 'cleanup',
        expectedGit: journal.checkpoint, expectedOid: journal.commit, side: journal.side }, AbortSignal.timeout(5_000)).catch(() => undefined);
    }
    throw error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

type Publication = Readonly<{ checkpoint: GitCheckpoint; operation: string; side: 'before' | 'after'; commit: string }>;
async function readPublication(scratch: string): Promise<Publication | null> {
  const handle = await open(join(scratch, 'prepared.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384) return null;
    const value: unknown = JSON.parse((await handle.readFile()).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 4 || !['before','after'].includes(String(record.side)) ||
        typeof record.operation !== 'string' || !/^[a-f0-9-]{36}$/.test(record.operation) ||
        !validGitCheckpoint(record.checkpoint, record.side === 'before')) return null;
    const checkpoint = record.checkpoint as GitCheckpoint;
    if (record.commit !== checkpoint[record.side as 'before' | 'after']) return null;
    return record as Publication;
  } catch { return null; } finally { await handle.close(); }
}

const HELPER = String.raw`
import os, sys, json, stat, subprocess, tempfile, re, resource
MAX_FILES = 32768
MAX_PATHS = 4194304
MAX_SCAN = 536870912
MAX_FILE = 67108864
MAX_TEXT = 131072
MAX_OBJECTS_KIB = 2097152
MAX_REFS = 1024
BASE = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.splitIndex=false']
# Bound every inherited Git process, including disk-backed outputs and object writes.
resource.setrlimit(resource.RLIMIT_FSIZE, (71303168, 71303168))
resource.setrlimit(resource.RLIMIT_AS, (805306368, 805306368))
fds = []
root = None
repo = None
env = dict(os.environ)

def ident(info): return dict(dev=info.st_dev, ino=info.st_ino)
def own(path, expected=None):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fds.append(fd)
    info = os.fstat(fd)
    if expected is not None and ident(info) != expected: raise ValueError('Workspace or Git directory identity changed.')
    return fd, ident(info)
def validate():
    for path, expected in ((request['cwd'], request['identity']), (repo['gitDir'], repo['gitIdentity']), (repo['commonDir'], repo['commonIdentity'])):
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or ident(info) != expected: raise ValueError('Workspace or Git directory identity changed.')

def git(args, data=None, limit=MAX_PATHS, extra=None):
    validate() if repo else None
    context = dict(env)
    if extra: context.update(extra)
    # Disk-backed output makes the byte bound independent of pipe buffering and avoids deadlocks.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(BASE + args, input=data, stdout=output, stderr=subprocess.DEVNULL,
            env=context, pass_fds=tuple(fds), timeout=20)
        if result.returncode != 0: raise ValueError('Git checkpoint operation failed.')
        if output.tell() > limit: raise ValueError('Git checkpoint output limit exceeded.')
        output.seek(0)
        value = output.read(limit + 1)
    validate() if repo else None
    return value

def path(value):
    parts = value.split('/')
    if ':' in value or len(value.encode()) > 4096 or len(parts) > 64 or any(p in ('', '.', '..') or p.lower() == '.git' for p in parts) or '\\' in value or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ValueError('A workspace filename is unsupported by the changes viewer.')
    return value

def oid(value):
    if not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', value): raise ValueError('Invalid Git object identity.')
    return value

def setup():
    global root, repo
    root, identity = own(request['cwd'], request['identity'])
    os.fchdir(root)
    gitdir = os.path.realpath(git(['rev-parse', '--absolute-git-dir'], limit=16384).decode().strip())
    common = os.path.realpath(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], limit=16384).decode().strip())
    prior = request.get('expectedGit') if request['mode'] == 'cleanup' else request.get('checkpoint')
    if prior and (prior['gitDir'] != gitdir or prior['commonDir'] != common): raise ValueError('Git repository was replaced.')
    gitfd, gitidentity = own(gitdir, prior['gitIdentity'] if prior else None)
    commonfd, commonidentity = own(common, prior['commonIdentity'] if prior else None)
    repo = dict(kind='git', cwd=request['cwd'], identity=identity, gitDir=gitdir, gitIdentity=gitidentity, commonDir=common, commonIdentity=commonidentity)
    # All subsequent Git access stays on the retained directories, including linked worktrees.
    if sys.platform.startswith('linux'):
        env['GIT_DIR'] = '/proc/self/fd/' + str(gitfd)
        env['GIT_COMMON_DIR'] = '/proc/self/fd/' + str(commonfd)
    else:
        env['GIT_DIR'] = gitdir
        env['GIT_COMMON_DIR'] = common
    env['GIT_WORK_TREE'] = os.getcwd()
    validate()
    if prior and request['mode'] != 'cleanup':
        for side in ('before', 'after'):
            value = prior.get(side)
            if value:
                actual = git(['rev-parse', '--verify', ref(side)], limit=256).decode().strip()
                if oid(actual) != value: raise ValueError('A retained Git checkpoint is missing or was changed.')
    return prior

def ref(side): return 'refs/codevo/turns/' + request['taskId'] + '/' + side

def quota():
    refs = git(['for-each-ref', '--format=%(refname)', 'refs/codevo/turns'], limit=262144).splitlines()
    if len(refs) >= MAX_REFS: raise ValueError('Git checkpoint retention limit reached; retained turns require cleanup.')
    values = dict(line.split(b': ', 1) for line in git(['count-objects', '-v'], limit=4096).splitlines())
    if int(values[b'size']) + int(values[b'size-pack']) > MAX_OBJECTS_KIB:
        raise ValueError('Git checkpoint object storage limit exceeded (2 GiB).')

def paths(tree=None):
    if tree:
        data = git(['ls-tree', '-rz', '--name-only', tree])
    else:
        data = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    values = set(data.decode('utf-8', errors='strict').split('\x00')) - {''}
    if len(values) > MAX_FILES: raise ValueError('Git checkpoint file limit exceeded (32768 files).')
    return values

def capture(prior):
    side = 'after' if prior else 'before'
    quota()
    existing = git(['for-each-ref', '--format=%(objectname)', ref(side)], limit=256).decode().strip()
    if existing: raise ValueError('A checkpoint already exists without its durable turn record.')
    names = paths()
    if prior: names |= paths(prior['before'])
    if len(names) > MAX_FILES: raise ValueError('Git checkpoint file limit exceeded (32768 files).')
    total = 0
    with tempfile.TemporaryDirectory(prefix='codevo-git-checkpoint-') as temporary:
        index = os.path.join(temporary, 'index')
        index_env = dict(GIT_INDEX_FILE=index)
        entries = bytearray()
        batch = []
        def flush():
            if not batch: return
            owned = [contents.fileno() for contents, mode, name in batch]
            fds.extend(owned)
            try:
                values = git(['hash-object', '-w', '--no-filters', '--stdin-paths'], data=''.join(('/proc/self/fd/' if sys.platform.startswith('linux') else '/dev/fd/') + str(fd) + '\n' for fd in owned).encode(), limit=8192).decode().splitlines()
                if len(values) != len(batch): raise ValueError('Incomplete Git object batch.')
                for (contents, mode, name), value in zip(batch, values):
                    entries.extend((mode + ' ' + oid(value) + '\t' + name + '\x00').encode())
            finally:
                del fds[-len(owned):]
                for contents, mode, name in batch: contents.close()
                batch.clear()
        for name in sorted(names):
            parts = path(name).split('/')
            opened = []
            directories = []
            try:
                directory = root
                for part in parts[:-1]:
                    parent = directory
                    directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    opened.append(directory)
                    directories.append((parent, part, ident(os.fstat(directory))))
                leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                opened.append(leaf)
                info = os.fstat(leaf)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('Git checkpoints do not follow symlinks or special files.')
                total += info.st_size
                if info.st_size > MAX_FILE or total > MAX_SCAN: raise ValueError('Git checkpoint scan limit exceeded (64 MiB/file, 512 MiB/turn).')
                # Keep each verified copy descriptor alive through a bounded no-filter hash batch.
                contents = tempfile.TemporaryFile()
                try:
                    length = 0
                    while length <= info.st_size:
                        chunk = os.read(leaf, min(65536, info.st_size + 1 - length))
                        if not chunk: break
                        contents.write(chunk); length += len(chunk)
                    if length != info.st_size: raise ValueError('A workspace file changed during checkpoint capture.')
                    contents.flush(); contents.seek(0)
                except BaseException:
                    contents.close(); raise
                after = os.fstat(leaf)
                now = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) or ident(now) != ident(info):
                    raise ValueError('A workspace file changed during checkpoint capture.')
                for parent, part, expected in directories:
                    now = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISDIR(now.st_mode) or ident(now) != expected: raise ValueError('A workspace directory changed during checkpoint capture.')
                mode = '100755' if info.st_mode & 0o111 else '100644'
                batch.append((contents, mode, name))
                if len(batch) >= 32: flush()
            except FileNotFoundError:
                pass
            finally:
                for fd in reversed(opened): os.close(fd)
        flush()
        git(['read-tree', '--empty'], extra=index_env, limit=256)
        git(['update-index', '-z', '--index-info'], data=bytes(entries), extra=index_env, limit=256)
        tree = oid(git(['write-tree'], extra=index_env, limit=256).decode().strip())
        commit_env = dict(GIT_AUTHOR_NAME='Codevo', GIT_AUTHOR_EMAIL='checkpoint@codevo.invalid', GIT_COMMITTER_NAME='Codevo', GIT_COMMITTER_EMAIL='checkpoint@codevo.invalid')
        commit = oid(git(['commit-tree', tree], data=('Codevo turn checkpoint\noperation:' + request['operation'] + '\n').encode(), extra=commit_env, limit=256).decode().strip())
        quota()
        checkpoint = dict(repo, before=prior['before'] if prior else commit, after=commit if prior else None)
        # Retain exact OID/authority before publication; Node owns cleanup even if this helper dies.
        with open(os.path.join(request['scratch'], 'prepared.json'), 'x', encoding='utf-8') as journal:
            json.dump(dict(checkpoint=checkpoint, operation=request['operation'], side=side, commit=commit), journal)
            journal.flush(); os.fsync(journal.fileno())
        # The zero old value makes refs single-assignment and never overwrites another task.
        git(['update-ref', ref(side), commit, '0' * len(commit)], limit=256)
    return dict(repo, before=prior['before'] if prior else commit, after=commit if prior else None)

def cleanup():
    # Compensate one prepared OID with the exact retained capture owner, never task-ref scans.
    expected = request.get('expectedOid')
    side = request.get('side')
    if expected is None or side not in ('before','after'): return dict(cleaned=True)
    expected = oid(expected)
    marker = ('\noperation:' + request['operation'] + '\n').encode()
    contents = git(['cat-file', 'commit', expected], limit=4096)
    if marker not in contents: raise ValueError('Capture ownership no longer matches.')
    values = git(['for-each-ref', '--format=%(objectname)', ref(side)], limit=256).decode().splitlines()
    if values and values[0] == expected:
        git(['update-ref', '-d', ref(side), expected], limit=256)
    return dict(cleaned=True)

def changes(checkpoint):
    data = git(['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=all', '-M100%', '-l32768', checkpoint['before'], checkpoint['after'], '--'])
    tokens = data.split(b'\x00')
    items = []
    i = 0
    while i < len(tokens) - 1:
        header = tokens[i].decode().split(); i += 1
        if len(header) != 5: raise ValueError('Invalid checkpoint diff.')
        oldmode, newmode, oldblob, newblob, status = header
        name = path(tokens[i].decode('utf-8', errors='strict')); i += 1
        oldname = None
        if status.startswith('R'):
            oldname = name
            name = path(tokens[i].decode('utf-8', errors='strict')); i += 1
        if status[0] not in 'AMDR': raise ValueError('Unsupported checkpoint file change.')
        items.append(dict(relativePath=name, oldRelativePath=oldname, status={'A':'added','M':'modified','D':'deleted','R':'renamed'}[status[0]], oldblob=oldblob, newblob=newblob))
    return sorted(items, key=lambda value:value['relativePath'])

reader = None
class BlobReader:
    def __init__(self):
        self.child = subprocess.Popen(BASE + ['cat-file', '--batch-command'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, pass_fds=tuple(fds))
    def command(self, command, value):
        validate()
        self.child.stdin.write((command + ' ' + oid(value) + '\n').encode()); self.child.stdin.flush()
        header = self.child.stdout.readline(257).split()
        if len(header) != 3 or len(header[0]) not in (40,64) or header[1] != b'blob': raise ValueError('Retained Git blob is missing.')
        return int(header[2])
    def read(self, value):
        if set(value) == {'0'}: return dict(text='', truncated=False, reason=None)
        size = self.command('info', value)
        if size > MAX_TEXT: return dict(text='', truncated=True, reason='large')
        if self.command('contents', value) != size: raise ValueError('Retained Git blob changed.')
        data = self.child.stdout.read(size)
        if len(data) != size or self.child.stdout.read(1) != b'\n': raise ValueError('Retained Git blob is incomplete.')
        validate()
        if b'\x00' in data: return dict(text='', truncated=False, reason='binary')
        try: return dict(text=data.decode('utf-8', errors='strict'), truncated=False, reason=None)
        except UnicodeDecodeError: return dict(text='', truncated=False, reason='binary')
    def close(self):
        self.child.stdin.close()
        self.child.stdout.close()
        try: self.child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.child.kill(); self.child.wait()

def blob(value):
    global reader
    if reader is None: reader = BlobReader()
    return reader.read(value)

def file_diff(item):
    original, modified = blob(item['oldblob']), blob(item['newblob'])
    reasons = (original['reason'], modified['reason'])
    reason = 'large' if 'large' in reasons else 'binary' if 'binary' in reasons else None
    return dict(relativePath=item['relativePath'], original=dict(text=original['text'], truncated=original['truncated']), modified=dict(text=modified['text'], truncated=modified['truncated']), unavailableReason=reason)

def summary(checkpoint):
    items = changes(checkpoint)
    data = git(['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=all', '--no-renames', checkpoint['before'], checkpoint['after'], '--'])
    counts = {}
    for token in data.split(b'\x00'):
        if not token: continue
        added, deleted, name = token.split(b'\t', 2)
        counts[name.decode('utf-8', errors='strict')] = (None, None) if added == b'-' else (int(added), int(deleted))
    files = []
    for item in items[:500]:
        diff = file_diff(item)
        added, deleted = (None, None) if diff['unavailableReason'] else (0, 0) if item['status'] == 'renamed' else counts[item['relativePath']]
        files.append(dict(relativePath=item['relativePath'], oldRelativePath=item['oldRelativePath'], status=item['status'], addedLines=added, deletedLines=deleted))
    truncated = len(items) > 500
    return dict(turnId=request['taskId'], state='ready', files=files, truncated=truncated, reason='Only the first 500 changed files are shown.' if truncated else None)

try:
    request = json.load(sys.stdin)
    tempfile.tempdir = request['scratch']
    if not re.fullmatch('[a-f0-9-]{36}', request['taskId']): raise ValueError('Invalid turn identity.')
    prior = setup()
    if request['mode'] in ('capture', 'cleanup') and not re.fullmatch('[a-f0-9-]{36}', request.get('operation','')): raise ValueError('Invalid capture ownership.')
    if request['mode'] == 'capture': response = capture(prior)
    elif request['mode'] == 'cleanup': response = cleanup()
    elif request['mode'] == 'summary' and prior and prior['after']: response = summary(prior)
    elif request['mode'] == 'diff' and prior and prior['after']:
        found = next((item for item in changes(prior)[:500] if item['relativePath'] == request['path']), None)
        if found is None: raise ValueError('Changed file not found in the retained turn.')
        response = file_diff(found)
    else: raise ValueError('Incomplete checkpoint.')
    validate()
    print(json.dumps(response, ensure_ascii=True))
except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
    message = str(error)
    allowed = ['A checkpoint already exists without its durable turn record.', 'A retained Git checkpoint is missing or was changed.', 'A workspace directory changed during checkpoint capture.', 'A workspace file changed during checkpoint capture.', 'A workspace filename is unsupported by the changes viewer.', 'Capture ownership no longer matches.', 'Changed file not found in the retained turn.', 'Git checkpoint file limit exceeded (32768 files).', 'Git checkpoint object storage limit exceeded (2 GiB).', 'Git checkpoint operation failed.', 'Git checkpoint output limit exceeded.', 'Git checkpoint retention limit reached; retained turns require cleanup.', 'Git checkpoint scan limit exceeded (64 MiB/file, 512 MiB/turn).', 'Git checkpoints do not follow symlinks or special files.', 'Git repository was replaced.', 'Incomplete Git object batch.', 'Incomplete checkpoint.', 'Invalid Git object identity.', 'Invalid capture ownership.', 'Invalid checkpoint diff.', 'Invalid turn identity.', 'Retained Git blob changed.', 'Retained Git blob is incomplete.', 'Retained Git blob is missing.', 'Unsupported checkpoint file change.', 'Workspace or Git directory identity changed.']
    print(json.dumps(dict(error=message if type(error) is ValueError and message in allowed else 'Recorded changes could not be captured or loaded.')))
finally:
    if reader is not None: reader.close()
    for fd in reversed(fds): os.close(fd)
`;


const safeReasons = new Set([...HELPER.matchAll(/raise ValueError\('([^']+)'\)/g)].map(match => match[1]));
/** No filesystem paths, process arguments or raw parser errors enter public reasons. */
export function checkpointFailureReason(error: unknown): string {
  return error instanceof Error && safeReasons.has(error.message) ? error.message : 'Recorded changes could not be captured or loaded.';
}
