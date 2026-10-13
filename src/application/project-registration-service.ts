import type { CloneDestinations } from './clone-ports.js';
import type { ProjectRegistry, WorkSource } from './execution-ports.js';
import type { ProjectFolderAdmission, ProjectFolderInspector, ProjectRegistrationApplication, ProjectRegistrationRepository, RetainedProjectFolder } from './project-registration-ports.js';
import { RunnerError } from '../domain/contracts.js';
import type { ProjectSummary, RegisteredProject } from '../domain/execution.js';
import { parseProjectRegistration, type ProjectRegistration } from '../domain/project-registration.js';

/** The folder stays retained until SQLite has decided conflicts, quota and the insert together. */
export class ProjectRegistrationService implements ProjectRegistrationApplication, WorkSource {
  private active = 0;
  private drained?: () => void;
  private readonly stopping = new AbortController();
  constructor(private readonly repository: ProjectRegistrationRepository, private readonly folders: ProjectFolderInspector,
    private readonly configured: ProjectRegistry, private readonly clones: CloneDestinations) {}
  get working(): boolean { return this.active > 0; }
  async register(value: unknown, signal: AbortSignal, admission: ProjectFolderAdmission = 'repository'): Promise<ProjectRegistration> {
    const input = parseProjectRegistration(value);
    if (this.stopping.signal.aborted || this.active >= 4) throw new RunnerError('busy');
    this.active++;
    const bounded = AbortSignal.any([signal, this.stopping.signal]);
    try {
      bounded.throwIfAborted();
      const folder = await this.folders.retain(input.path, bounded, admission);
      try { return await this.decide(folder, input.name, admission, bounded); }
      finally { await folder.close(); }
    } finally {
      this.active--;
      if (!this.active) this.drained?.();
    }
  }
  private async decide(folder: RetainedProjectFolder, name: string, admission: ProjectFolderAdmission, signal: AbortSignal): Promise<ProjectRegistration> {
    switch (folder.verdict) {
      case 'not_allowed': case 'not_git_root': return { status: 'rejected', reason: folder.verdict };
      case 'git_root': return this.admit(folder, { id: name, name, path: folder.path }, signal);
      case 'folder': return this.admitFolder(folder, name, admission, signal);
      default: return unreachable(folder.verdict);
    }
  }
  private async admitFolder(folder: RetainedProjectFolder, name: string, admission: ProjectFolderAdmission, signal: AbortSignal): Promise<ProjectRegistration> {
    switch (admission) {
      case 'repository': return { status: 'rejected', reason: 'not_git_root' };
      case 'repository-or-folder': return this.admit(folder, { id: name, name, path: folder.path, kind: 'folder' }, signal);
      default: return unreachable(admission);
    }
  }
  private async admit(folder: RetainedProjectFolder, project: RegisteredProject, signal: AbortSignal): Promise<ProjectRegistration> {
    const configured = await this.configured.list();
    const host = await this.hostProject(folder, configured);
    if (host) return { status: 'registered', project: { id: host.id, name: host.name }, created: false };
    if (!await folder.owned()) throw new RunnerError('storage_unavailable');
    signal.throwIfAborted();
    if (this.clones.reserves(folder.path, folder.root)) return { status: 'rejected', reason: 'not_allowed' };
    return this.repository.registerManagedProject(project, configured, folder.root);
  }
  private async hostProject(folder: RetainedProjectFolder, configured: readonly ProjectSummary[]): Promise<ProjectSummary | undefined> {
    for (const project of configured) {
      if (await folder.matches((await this.configured.get(project.id)).path)) return project;
    }
    return undefined;
  }
  async close() {
    this.stopping.abort(new RunnerError('busy'));
    if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled project folder case: ${String(value)}`);
}
