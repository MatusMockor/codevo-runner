import type { CloneApplication, CloneRepository, ProjectCloner, PreparedClone } from './clone-ports.js';
import type { ProjectRegistry } from './execution-ports.js';
import { isId, RunnerError } from '../domain/contracts.js';
import { parseCloneInput } from '../domain/project-clone.js';

/** A single owned worker survives HTTP/SSH disconnects; SQLite owns durable state. */
export class ProjectCloneService implements CloneApplication {
  private worker?: Promise<void>;
  private active?: { id: string; controller: AbortController };
  private closed = false;
  private admissions = 0;
  private timer?: NodeJS.Timeout;
  private drained?: () => void;
  constructor(private readonly repository: CloneRepository, private readonly cloner: ProjectCloner,
    private readonly configured: ProjectRegistry) {}
  async initialize() {
    await this.repository.interruptClones();
    this.timer = setInterval(() => this.wake(), 500);
    this.timer.unref();
  }
  async create(value: unknown) {
    const input = parseCloneInput(value);
    if (this.closed || this.admissions >= 8) throw new RunnerError('busy');
    this.admissions++;
    try {
      const configured = await this.configured.list();
      if (configured.some(project => project.id === input.name)) throw new RunnerError('conflict');
      if (this.closed) throw new RunnerError('busy');
      const job = await this.repository.createClone(input, Math.max(0, 32 - configured.length));
      this.wake();
      return job;
    } finally {
      this.admissions--;
      if (!this.admissions) this.drained?.();
    }
  }
  async get(id: string) {
    if (!isId(id)) throw new RunnerError('invalid_input');
    return this.repository.getClone(id);
  }
  async cancel(id: string) {
    if (!isId(id)) throw new RunnerError('invalid_input');
    const job = await this.repository.cancelClone(id);
    if (this.active?.id === id) this.active.controller.abort();
    return job;
  }
  private wake() {
    if (this.worker || this.closed) return;
    this.worker = this.run().catch(() => { /* Repository failure is surfaced by subsequent reads. */ }).finally(() => {
      this.worker = undefined;
    });
  }
  private async run() {
    while (!this.closed) {
      const next = await this.repository.claimClone();
      if (!next) return;
      const controller = new AbortController();
      this.active = { id: next.job.id, controller };
      if (this.closed || (await this.repository.getClone(next.job.id)).status !== 'running') controller.abort();
      let prepared: PreparedClone | undefined;
      let published = false;
      let publishing = false;
      try {
        prepared = await this.cloner.clone(next.input, next.job.id, controller.signal);
        controller.signal.throwIfAborted();
        publishing = true;
        const finished = await this.repository.finishClone(next.job.id, 'succeeded', prepared.project, null);
        published = finished.status === 'succeeded';
        publishing = false;
      } catch {
        await this.repository.finishClone(next.job.id, this.closed ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed', null,
          this.closed ? 'Runner stopped during cloning.' : controller.signal.aborted ? null : 'Clone failed. Check repository access, branch and destination on the server.');
      } finally {
        if (publishing) {
          // A missing worker reply is not proof that the registration failed.
          try { published = (await this.repository.getClone(next.job.id)).status === 'succeeded'; }
          catch { published = true; }
        }
        try { if (prepared && !published) await prepared.rollback(); }
        finally { this.active = undefined; }
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    if (this.admissions) await new Promise<void>(resolve => { this.drained = resolve; });
    await this.worker;
    await this.repository.interruptClones();
  }
}

/** Persisted registrations extend the host configuration without editing its file. */
export class ManagedProjectRegistry implements ProjectRegistry {
  constructor(private readonly configured: ProjectRegistry, private readonly repository: CloneRepository) {}
  private async projects() {
    const configured = await this.configured.list();
    const managed = await this.repository.listManagedProjects();
    for (const project of managed) {
      if (!configured.some(item => item.id === project.id)) continue;
      const host = await this.configured.get(project.id);
      if (host.path !== project.path) throw new RunnerError('conflict');
    }
    return { configured, managed };
  }
  async list() {
    const { configured, managed } = await this.projects();
    const ids = new Set(configured.map(project => project.id));
    return [...configured, ...managed.filter(project => !ids.has(project.id)).map(({ id, name }) => ({ id, name }))];
  }
  async get(id: string) {
    const { configured, managed } = await this.projects();
    if (configured.some(project => project.id === id)) return this.configured.get(id);
    const project = managed.find(item => item.id === id);
    if (!project) throw new RunnerError('not_found');
    return project;
  }
}
