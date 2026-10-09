import { isId, RunnerError } from './contracts.js';

export type MaintenancePrepare = Readonly<{ leaseId: string }>;
export type MaintenanceLeaseGrant = Readonly<{ leaseId: string; runnerId: string; expiresInMs: number }>;
export type MaintenanceRelease = Readonly<{ leaseId: string; released: boolean }>;
export type RunnerActivity = Readonly<{ activeTasks: number; activeClones: number; queuedPendingMessages: number }>;

export function parseMaintenancePrepare(input: unknown): MaintenancePrepare {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RunnerError('invalid_input');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !isId(record.leaseId)) throw new RunnerError('invalid_input');
  return { leaseId: record.leaseId };
}

export function parseMaintenanceLeaseId(value: unknown): string {
  if (!isId(value)) throw new RunnerError('invalid_input');
  return value;
}

export function isRunnerActive(activity: RunnerActivity): boolean {
  return activity.activeTasks > 0 || activity.activeClones > 0 || activity.queuedPendingMessages > 0;
}
