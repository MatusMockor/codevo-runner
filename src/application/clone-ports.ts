import type { CloneInput, CloneJob, StoredClone } from '../domain/project-clone.js';
import type { RegisteredProject } from '../domain/execution.js';
export interface CloneRepository {
  createClone(input: CloneInput, maximumProjects?: number): Promise<CloneJob>;
  getClone(id: string): Promise<CloneJob>;
  claimClone(): Promise<StoredClone | null>;
  finishClone(id: string, status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled', project: RegisteredProject | null, error: string | null): Promise<CloneJob>;
  cancelClone(id: string): Promise<CloneJob>;
  interruptClones(): Promise<void>;
  listManagedProjects(): Promise<readonly RegisteredProject[]>;
}
export type PreparedClone = Readonly<{ project: RegisteredProject; rollback(): Promise<void> }>;
export interface ProjectCloner {
  clone(input: CloneInput, jobId: string, signal: AbortSignal): Promise<PreparedClone>;
}
export interface CloneApplication {
  create(value: unknown): Promise<CloneJob>;
  get(id: string): Promise<CloneJob>;
  cancel(id: string): Promise<CloneJob>;
  close(): Promise<void>;
}
