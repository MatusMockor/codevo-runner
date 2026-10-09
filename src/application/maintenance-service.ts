import { RunnerError } from '../domain/contracts.js';
import {
  isRunnerActive, parseMaintenanceLeaseId, parseMaintenancePrepare,
  type MaintenanceLeaseGrant, type MaintenanceRelease, type RunnerActivity,
} from '../domain/maintenance.js';
import type { WorkSource } from './execution-ports.js';
import type { LeaseReservation, MaintenanceLease, RequestAdmission } from './maintenance-lease.js';

export const MAINTENANCE_UPDATE_PROTOCOL_VERSION = 1;

export interface IdleProbe {
  idle(): Promise<boolean>;
}

export interface RunnerActivityRepository {
  runnerActivity(): Promise<RunnerActivity>;
}

export interface MaintenanceApplication {
  prepare(input: unknown): Promise<MaintenanceLeaseGrant>;
  release(leaseId: unknown): MaintenanceRelease;
  admit(): RequestAdmission;
}

export class RunnerIdleProbe implements IdleProbe {
  constructor(private readonly repository: RunnerActivityRepository, private readonly sources: readonly WorkSource[]) {}

  async idle(): Promise<boolean> {
    if (this.working()) return false;
    if (isRunnerActive(await this.repository.runnerActivity())) return false;
    return !this.working();
  }

  private working(): boolean { return this.sources.some(source => source.working); }
}

export class MaintenanceService implements MaintenanceApplication {
  constructor(private readonly runnerId: string, private readonly lease: MaintenanceLease, private readonly probe: IdleProbe) {}

  admit(): RequestAdmission { return this.lease.admit(); }

  async prepare(input: unknown): Promise<MaintenanceLeaseGrant> {
    const { leaseId } = parseMaintenancePrepare(input);
    const claim = this.lease.claim(leaseId);
    switch (claim.kind) {
      case 'refused': throw new RunnerError('conflict');
      case 'renewed': return this.grant(leaseId, claim.expiresInMs);
      case 'reserved': return this.confirm(claim.reservation);
      default: return unreachable(claim);
    }
  }

  release(leaseId: unknown): MaintenanceRelease {
    const id = parseMaintenanceLeaseId(leaseId);
    return { leaseId: id, released: this.lease.release(id) };
  }

  private async confirm(reservation: LeaseReservation): Promise<MaintenanceLeaseGrant> {
    let idle = false;
    try { idle = await this.probe.idle(); }
    finally { if (!idle) this.lease.abandon(reservation); }
    if (!idle) throw new RunnerError('conflict');
    const confirmation = this.lease.confirm(reservation);
    if (confirmation.kind === 'lost') throw new RunnerError('conflict');
    return this.grant(reservation.leaseId, confirmation.expiresInMs);
  }

  private grant(leaseId: string, expiresInMs: number): MaintenanceLeaseGrant {
    return { leaseId, runnerId: this.runnerId, expiresInMs };
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled maintenance claim: ${String(value)}`);
}
