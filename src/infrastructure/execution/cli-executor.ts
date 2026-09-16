import { ARTIFACT_HINT } from '../../domain/artifact-hint.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ProviderExecutor } from '../../application/execution-ports.js';
import { LIMITS } from '../../domain/contracts.js';
import type { ExecutionRequest, ExecutionResult } from '../../domain/execution.js';
import { isProviderSessionId, ProviderOutputParser } from '../../domain/provider-output.js';
import { parseLaunchOptions } from '../../domain/launch.js';
import { launchArguments, launchPrompt } from '../../domain/launch-arguments.js';
import { runProcess } from './process-runner.js';

export type CliExecutorOptions = Readonly<{
  /** Trusted operator configuration; never HTTP request fields. */
  executable?: string; timeoutMs?: number; outputBytes?: number;
  sandbox?: 'workspace-write' | 'external-sandbox';
}>;

const ENVIRONMENT_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;

/** Provider-specific command translation; credentials remain on the execution host. */
export class CliProviderExecutor implements ProviderExecutor {
  readonly supportsAttachments = true;
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly outputBytes: number;
  private readonly sandbox: 'workspace-write' | 'external-sandbox';

  constructor(readonly provider: 'codex' | 'claude', options: CliExecutorOptions = {}) {
    this.executable = options.executable ?? provider;
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.outputBytes = options.outputBytes ?? 1_048_576;
    this.sandbox = options.sandbox ?? 'workspace-write';
    if (!['workspace-write', 'external-sandbox'].includes(this.sandbox)) throw new Error('invalid_sandbox');
    if (!this.executable || this.executable.includes('\0')) throw new Error('invalid_provider_executable');
    if (this.executable !== provider && !isAbsolute(this.executable)) throw new Error('invalid_provider_executable');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 86_400_000) throw new Error('invalid_execution_timeout');
    if (!Number.isSafeInteger(this.outputBytes) || this.outputBytes < 1 || this.outputBytes > 1_048_576) throw new Error('invalid_output_limit');
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.task.provider !== this.provider) return { exitCode: null, error: 'provider_mismatch' };
    if (request.signal.aborted) return { exitCode: null, error: 'cancelled' };
    if (request.resumeSessionId !== undefined && !isProviderSessionId(request.resumeSessionId)) return { exitCode: null, error: 'provider_session_invalid' };
    let launch;
    try { launch = request.task.launch === undefined ? undefined : parseLaunchOptions(request.task.launch, this.provider); }
    catch { return { exitCode: null, error: 'launch_options_invalid' }; }
    const references = request.task.parts.filter(part => part.type === 'attachment');
    if (references.length !== request.attachments.length || references.length > LIMITS.attachmentsPerTask ||
      references.some((part, index) => part.attachmentId !== request.attachments[index]?.id)) {
      return { exitCode: null, error: 'attachment_input_invalid' };
    }
    const rawPrompt = request.task.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const prompt = launch ? launchPrompt(launch, rawPrompt) : rawPrompt;
    const images: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];
    try {
      for (const attachment of request.attachments) {
        if (!isAbsolute(attachment.path) || !['image/png', 'image/jpeg'].includes(attachment.mediaType)) throw new Error('invalid_attachment');
        const handle = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.attachmentBytes) throw new Error('invalid_attachment');
          if (this.provider === 'claude') {
            // Read at most the validated allocation even if a file grows concurrently.
            const bytes = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < bytes.length) {
              const read = await handle.read(bytes, offset, bytes.length - offset, offset);
              if (!read.bytesRead) throw new Error('attachment_changed');
              offset += read.bytesRead;
            }
            images.push({ type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: bytes.toString('base64') } });
          }
        } finally { await handle.close(); }
        if (request.signal.aborted) return { exitCode: null, error: 'cancelled' };
      }
    } catch { return { exitCode: null, error: 'attachment_input_invalid' }; }
    const args = this.provider === 'codex'
      ? ['exec', ...(request.resumeSessionId ? ['resume'] : []), '--json',
        ...(launch ? launchArguments(launch, Boolean(request.resumeSessionId)) : ['-c', `sandbox_mode="${this.sandbox === 'external-sandbox' ? 'danger-full-access' : 'workspace-write'}"`,
        '-c', 'approval_policy="never"']), ...request.attachments.flatMap(image => ['-i', image.path]), '--',
        ...(request.resumeSessionId ? [request.resumeSessionId] : []), '-']
      : ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
        '--append-system-prompt', ARTIFACT_HINT,
        ...(launch ? launchArguments(launch, Boolean(request.resumeSessionId)) : ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash']),
        ...(request.resumeSessionId ? ['--resume', request.resumeSessionId] : [])];
    // Codex exec requires nonempty stdin even when image flags are present.
    const stdin = this.provider === 'codex' ? `[Codevo presentation capability]\n${ARTIFACT_HINT}\n[User request]\n${prompt || 'Inspect the attached images.'}` : `${JSON.stringify({
      type: 'user', message: { role: 'user', content: [...images, ...(prompt ? [{ type: 'text', text: prompt }] : [])] },
    })}\n`;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENVIRONMENT_KEYS) if (process.env[key]) env[key] = process.env[key];
    const parser = new ProviderOutputParser(this.provider, request.resumeSessionId);
    let sessionPublished = false;
    const result = await runProcess({ executable: this.executable, args, cwd: request.cwd, stdin, env,
      signal: request.signal, timeoutMs: this.timeoutMs, outputBytes: this.outputBytes, onOutput: async (channel, text) => {
        if (channel === 'stdout') parser.push(text);
        const sessionId = parser.currentSessionId();
        if (sessionId && !sessionPublished) {
          await request.onSession?.(sessionId);
          sessionPublished = true;
        }
        await request.onOutput(channel, text);
      } });
    const parsed = parser.finish();
    if (result.error || result.exitCode !== 0) return { ...parsed, ...result };
    return { ...result, ...parsed };
  }
}
