import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, join } from 'node:path';
import sharp from 'sharp';
import type { ArtifactWorkspace } from '../../application/artifact-ports.js';
import type { ExecutionRepository, ProjectRegistry, ProjectWorkspace } from '../../application/execution-ports.js';
import type { TaskRepository } from '../../application/ports.js';
import { ARTIFACT_LIMITS, artifactMediaType } from '../../domain/artifact.js';
import { LIMITS, RunnerError } from '../../domain/contracts.js';
import { validateWorkspacePath } from '../../domain/workspace-files.js';
import { runProcess } from '../execution/process-runner.js';
import { validateImageEnvelope } from '../files/image-preflight.js';

const READER = String.raw`
import os,stat,sys,json,base64
fds=[]
try:
 r=json.load(sys.stdin)
 root=os.open(r['cwd'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(root)
 identity=os.fstat(root)
 if (identity.st_dev,identity.st_ino)!=(r['dev'],r['ino']):raise ValueError()
 directory=root
 parts=r['path'].split('/')
 for part in parts[:-1]:
  directory=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);fds.append(directory)
 leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);fds.append(leaf)
 before=os.fstat(leaf)
 if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:raise ValueError()
 if before.st_size>r['limit']:raise OverflowError()
 data=bytearray()
 while len(data)<=r['limit']:
  chunk=os.read(leaf,r['limit']+1-len(data))
  if not chunk:break
  data.extend(chunk)
 after=os.fstat(leaf)
 if (before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_nlink)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_nlink):raise ValueError()
 if len(data)>r['limit']:raise OverflowError()
 print(json.dumps({'data':base64.b64encode(data).decode('ascii')}))
except FileNotFoundError:print(json.dumps({'error':'not_found'}))
except OverflowError:print(json.dumps({'error':'too_large'}))
except (OSError,ValueError,KeyError,TypeError):print(json.dumps({'error':'conflict'}))
finally:
 for fd in reversed(fds):os.close(fd)
`;

export class WorkspaceArtifactReader implements ArtifactWorkspace {
  constructor(private readonly tasks: TaskRepository, private readonly executions: ExecutionRepository,
    private readonly registry: ProjectRegistry, private readonly workspaces: ProjectWorkspace, private readonly workspaceRoot: string) {}
  private async root(taskId: string) {
    const task = await this.tasks.getTask(taskId);
    if (!task.projectId) throw new RunnerError('conflict');
    const { workspaceTaskId } = await this.executions.getTaskSession(taskId);
    const project = await this.registry.get(task.projectId);
    return this.workspaces.resume(project, workspaceTaskId, AbortSignal.timeout(10_000));
  }
  async normalize(taskId: string, path: string) {
    if (!isAbsolute(path)) return validateWorkspacePath(path.replace(/^\.\//, ''));
    const task = await this.tasks.getTask(taskId);
    if (task.isolation === 'in-place') {
      const cwd = await this.root(taskId);
      const lexical = relative(cwd, path);
      return validateWorkspacePath(lexical.startsWith('../') ? relative(await realpath(cwd), path) : lexical);
    }
    const { workspaceTaskId } = await this.executions.getTaskSession(taskId);
    const cwd = join(this.workspaceRoot, workspaceTaskId);
    const lexical = relative(cwd, path);
    return validateWorkspacePath(lexical.startsWith('../') ? relative(join(await realpath(this.workspaceRoot), workspaceTaskId), path) : lexical);
  }
  async capture(taskId: string, path: string) {
    validateWorkspacePath(path);
    if ((await this.executions.getResumeState(taskId)).reason === 'newer_turn_exists') throw new RunnerError('conflict');
    const mediaType = artifactMediaType(path);
    const cwd = await realpath(await this.root(taskId));
    const identity = await lstat(cwd);
    const limit = mediaType === 'text/html' ? ARTIFACT_LIMITS.htmlBytes : ARTIFACT_LIMITS.imageBytes;
    let stdout = '';
    const execution = await runProcess({ executable: 'python3', args: ['-I', '-S', '-c', READER], cwd: '/',
      env: { PATH: process.env.PATH }, stdin: JSON.stringify({ cwd, dev: identity.dev, ino: identity.ino, path, limit }),
      signal: AbortSignal.timeout(10_000), timeoutMs: 10_000, outputBytes: Math.ceil(limit * 4 / 3) + 1024,
      onOutput: async (channel, text) => { if (channel === 'stdout') stdout += text; } });
    if (execution.error || execution.exitCode !== 0) throw new RunnerError('storage_unavailable');
    const value = JSON.parse(stdout) as { error?: string; data?: string };
    if (value.error === 'not_found' || value.error === 'too_large' || value.error === 'conflict') throw new RunnerError(value.error);
    if (typeof value.data !== 'string') throw new RunnerError('storage_unavailable');
    const bytes = Buffer.from(value.data, 'base64');
    if (!bytes.length || bytes.length > limit) throw new RunnerError('too_large');
    if (mediaType === 'text/html') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new RunnerError('unsupported_media'); }
      if (bytes.includes(0)) throw new RunnerError('unsupported_media');
    } else {
      if (mediaType !== 'image/webp') validateImageEnvelope(bytes, mediaType);
      else if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length)
        throw new RunnerError('unsupported_media');
      try {
        const image = sharp(bytes, { limitInputPixels: LIMITS.imagePixels, failOn: 'warning', animated: true });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || metadata.width > LIMITS.imageDimension || metadata.height > LIMITS.imageDimension || (metadata.pages ?? 1) > 1)
          throw new RunnerError('too_large');
        await image.raw().toBuffer();
      } catch (error) { if (error instanceof RunnerError) throw error; throw new RunnerError('unsupported_media'); }
    }
    const currentRoot = await this.root(taskId);
    const current = await lstat(currentRoot);
    if (current.dev !== identity.dev || current.ino !== identity.ino || await realpath(currentRoot) !== cwd) throw new RunnerError('conflict');
    return { path, bytes };
  }
}
