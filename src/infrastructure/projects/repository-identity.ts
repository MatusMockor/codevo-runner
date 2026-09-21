import { RunnerError } from '../../domain/contracts.js';
import type { RegisteredProject } from '../../domain/execution.js';
import { canonicalRepositoryKey } from '../../domain/repository-identity.js';
import { git } from './git-command.js';
import { captureWorkspace, validateWorkspace } from './workspace-metadata.js';

/** Bounded, pinned, read-only origin lookup; no URL or credentials cross the boundary. */
export class ProjectRepositoryIdentity {
  private active = 0;
  async read(project: RegisteredProject, callerSignal?: AbortSignal): Promise<string | null> {
    if (this.active >= 2) throw new RunnerError('busy');
    this.active++;
    const timeout = AbortSignal.timeout(5_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const metadata = await captureWorkspace(project, 'in-place', signal);
      let key: string | null = null;
      try {
        const result = await git(metadata.source, ['config', '--local', '--no-includes', '--get', 'remote.origin.url'], signal, metadata.sourceIdentity);
        if (!result.truncated) key = canonicalRepositoryKey(result.text.replace(/\n$/, ''));
      } catch {
        // No origin is normal. Ownership and cancellation are still checked below.
        signal.throwIfAborted();
      }
      await validateWorkspace(metadata, project, signal);
      return key;
    } finally { this.active--; }
  }
}
