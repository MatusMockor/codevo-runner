import { RunnerError } from '../../domain/contracts.js';
import { validateWorkspacePath } from '../../domain/workspace-files.js';
import { runProcess } from '../execution/process-runner.js';

export type SafeWorkspaceRead = Readonly<{
  text: string;
  truncated: boolean;
  unavailableReason: 'binary' | 'large' | null;
}>;

// Every lookup below the captured workspace uses an owned directory descriptor.
// Neither workspace paths nor file contents become executable Python source.
const READER = String.raw`
import errno, json, os, stat, sys
fds = []
def result(text='', truncated=False, unavailableReason=None):
    return dict(text=text, truncated=truncated, unavailableReason=unavailableReason)
def read_file(request):
    root = os.open(request['cwd'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fds.append(root)
    identity = os.fstat(root)
    if identity.st_dev != request['expected']['dev'] or identity.st_ino != request['expected']['ino']:
        raise ValueError('identity')
    parts = request['path'].split('/')
    directory = root
    for part in parts[:-1]:
        directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        fds.append(directory)
    leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    fds.append(leaf)
    info = os.fstat(leaf)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('file')
    if info.st_size > 65536:
        return result(truncated=True, unavailableReason='large')
    data = bytearray()
    while len(data) <= 65536:
        chunk = os.read(leaf, 65537 - len(data))
        if not chunk:
            break
        data.extend(chunk)
    after = os.fstat(leaf)
    if after.st_nlink != 1 or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('changed')
    if len(data) > 65536:
        return result(truncated=True, unavailableReason='large')
    if b'\x00' in data:
        return result(unavailableReason='binary')
    try:
        return result(text=data.decode('utf-8', errors='strict'))
    except UnicodeDecodeError:
        return result(unavailableReason='binary')
try:
    request = json.load(sys.stdin)
    try:
        response = read_file(request)
    except OSError as error:
        if error.errno != errno.ENOENT or not fds:
            raise
        response = result()
    print(json.dumps(response, ensure_ascii=True))
except (OSError, ValueError, KeyError, TypeError):
    print(json.dumps(dict(error='conflict')))
finally:
    for fd in reversed(fds):
        os.close(fd)
`;

export async function readSafeWorkspaceFile(input: Readonly<{
  cwd: string;
  expected: Readonly<{ dev: number; ino: number }>;
  path: string;
}>): Promise<SafeWorkspaceRead> {
  validateWorkspacePath(input.path);
  if (!input.cwd.startsWith('/') || input.cwd.includes('\0') || input.cwd.endsWith('/') ||
      Buffer.byteLength(input.cwd) > 16_384 ||
      !Number.isSafeInteger(input.expected.dev) || input.expected.dev < 0 ||
      !Number.isSafeInteger(input.expected.ino) || input.expected.ino < 0) {
    throw new RunnerError('conflict');
  }
  let stdout = '';
  const execution = await runProcess({
    executable: 'python3', args: ['-I', '-S', '-c', READER], cwd: '/',
    stdin: JSON.stringify(input), env: { PATH: process.env.PATH },
    signal: new AbortController().signal, timeoutMs: 5_000, outputBytes: 512 * 1024,
    onOutput: async (channel, text) => { if (channel === 'stdout') stdout += text; },
  });
  if (execution.error || execution.exitCode !== 0) throw new RunnerError('storage_unavailable');
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new RunnerError('storage_unavailable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('storage_unavailable');
  const response = value as Record<string, unknown>;
  if (response.error === 'conflict') throw new RunnerError('conflict');
  if (Object.keys(response).length !== 3 || typeof response.text !== 'string' ||
      Buffer.byteLength(response.text) > 65_536 || typeof response.truncated !== 'boolean' ||
      ![null, 'binary', 'large'].includes(response.unavailableReason as null | string) ||
      response.truncated !== (response.unavailableReason === 'large') ||
      (response.unavailableReason !== null && response.text !== '')) {
    throw new RunnerError('storage_unavailable');
  }
  return response as SafeWorkspaceRead;
}
