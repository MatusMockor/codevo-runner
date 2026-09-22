import { validSnapshot } from './turn-changes-codec.js';
import { runProcess } from '../execution/process-runner.js';

export type CapturedFile = Readonly<{ path: string; hash: string; executable: boolean; text: string; unavailable: 'binary' | 'large' | null }>;
export type TurnSnapshot = Readonly<{ files: readonly CapturedFile[] }>;
export async function runTurnHelper(input: unknown, signal: AbortSignal): Promise<unknown> {
  let output = '';
  const execution = await runProcess({ executable: 'python3', args: ['-I', '-S', '-c', HELPER], cwd: '/',
    stdin: JSON.stringify(input), env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' }, signal, timeoutMs: 30_000, outputBytes: 24 * 1024 * 1024,
    onOutput: async (channel, text) => { if (channel === 'stdout') output += text; },
  });
  if (execution.error || execution.exitCode !== 0) throw new Error('Turn snapshot could not be captured.');
  const result: unknown = JSON.parse(output);
  if (!result || typeof result !== 'object' || 'error' in result) throw new Error('Turn snapshot is unavailable or exceeds capture limits.');
  if ((input as { mode?: string }).mode === 'capture' && !validSnapshot(result)) throw new Error('Invalid snapshot.');
  return result;
}
const HELPER = String.raw`
import os, sys, json, stat, hashlib, subprocess, tempfile
MAX_TEXT = 131072
MAX_TOTAL = 8388608

def capture(request):
    root = os.open(request['cwd'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(root)
        if (identity.st_dev, identity.st_ino) != (request['identity']['dev'], request['identity']['ino']):
            raise ValueError('identity')
        os.fchdir(root)
        listing = subprocess.Popen(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        data = listing.stdout.read(1048577)
        if len(data) > 1048576:
            listing.kill()
            listing.wait()
            raise ValueError('paths limit')
        if listing.wait() != 0:
            raise ValueError('not git')
        paths = sorted((set(data.decode('utf-8', errors='strict').split('\x00')) | set(request.get('baselinePaths', []))) - {''})
        if len(paths) > 8192:
            raise ValueError('file limit')
        files, total, scanned = [], 0, 0
        for path in paths:
            parts = path.split('/')
            if ':' in path or len(path.encode()) > 4096 or len(parts) > 64 or any(p in ('', '.', '..') or p.lower() == '.git' for p in parts) or '\\' in path or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in path):
                raise ValueError('path')
            fds = []
            try:
                directory = root
                for part in parts[:-1]:
                    directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    fds.append(directory)
                leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                fds.append(leaf)
                info = os.fstat(leaf)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8388608:
                    raise ValueError('unsupported file')
                contents = bytearray()
                while len(contents) <= 8388608:
                    chunk = os.read(leaf, min(65536, 8388609 - len(contents)))
                    if not chunk: break
                    contents.extend(chunk)
                after = os.fstat(leaf)
                if (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink):
                    raise ValueError('file changed')
                scanned += len(contents)
                if len(contents) > 8388608 or scanned > 67108864:
                    raise ValueError('scan limit')
                unavailable, text = None, ''
                if len(contents) > MAX_TEXT: unavailable = 'large'
                elif b'\x00' in contents: unavailable = 'binary'
                else:
                    try: text = contents.decode('utf-8', errors='strict')
                    except UnicodeDecodeError: unavailable = 'binary'
                total += len(text.encode())
                if total > MAX_TOTAL: raise ValueError('text limit')
                files.append(dict(path=path, hash=hashlib.sha256(contents).hexdigest(), executable=bool(info.st_mode & 0o111), text=text, unavailable=unavailable))
            except FileNotFoundError:
                pass
            finally:
                for fd in reversed(fds): os.close(fd)
        now = os.stat(request['cwd'], follow_symlinks=False)
        if not stat.S_ISDIR(now.st_mode) or (now.st_dev, now.st_ino) != (identity.st_dev, identity.st_ino):
            raise ValueError('identity changed')
        return dict(files=files)
    finally: os.close(root)

def counts(request):
    with tempfile.TemporaryDirectory(prefix='codevo-turn-') as root:
        before, after = os.path.join(root, 'before'), os.path.join(root, 'after')
        os.mkdir(before); os.mkdir(after)
        for i, pair in enumerate(request['pairs']):
            for directory, key in ((before, 'original'), (after, 'modified')):
                with open(os.path.join(directory, str(i)), 'w', encoding='utf-8', newline='') as f: f.write(pair[key])
        result = subprocess.run(['git', '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', before, after], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode not in (0, 1) or len(result.stdout) > 131072: raise ValueError('diff failed')
        values = [[0,0] for p in request['pairs']]
        for line in result.stdout.decode().splitlines():
            added, deleted, path = line.split('\t', 2)
            index = int(path.rsplit('/',1)[-1])
            values[index] = [int(added), int(deleted)]
        return dict(counts=values)
try:
    request = json.load(sys.stdin)
    print(json.dumps(capture(request) if request['mode'] == 'capture' else counts(request), ensure_ascii=True))
except Exception:
    print(json.dumps(dict(error='unavailable')))
`;
