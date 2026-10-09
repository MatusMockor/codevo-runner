import type { WorkAdmission } from './execution-ports.js';

export const MAINTENANCE_LEASE_MS = 30_000;

export interface MaintenanceClock {
  now(): number;
  schedule(delayMs: number, action: () => void): () => void;
}

export const systemMaintenanceClock: MaintenanceClock = {
  now: () => performance.now(),
  schedule: (delayMs, action) => {
    const timer = setTimeout(action, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

type FencedState =
  | Readonly<{ kind: 'probing'; leaseId: string; expiresAt: number }>
  | Readonly<{ kind: 'held'; leaseId: string; expiresAt: number }>;
type LeaseState = Readonly<{ kind: 'free' }> | FencedState;

export type LeaseReservation = Readonly<{ leaseId: string }>;
export type LeaseClaim =
  | Readonly<{ kind: 'renewed'; expiresInMs: number }>
  | Readonly<{ kind: 'reserved'; reservation: LeaseReservation }>
  | Readonly<{ kind: 'refused' }>;
export type LeaseConfirmation = Readonly<{ kind: 'held'; expiresInMs: number }> | Readonly<{ kind: 'lost' }>;
export type RequestAdmission = Readonly<{ kind: 'admitted'; release(): void }> | Readonly<{ kind: 'refused' }>;

const FREE: LeaseState = Object.freeze({ kind: 'free' });
const noop = () => undefined;

export class MaintenanceLease implements WorkAdmission {
  private state: LeaseState = FREE;
  private inFlight = 0;
  private closed = false;
  private cancelExpiry: () => void = noop;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clock: MaintenanceClock = systemMaintenanceClock, startLeaseId?: string) {
    if (startLeaseId !== undefined) this.enter({ kind: 'held', leaseId: startLeaseId, expiresAt: this.deadline() });
  }

  get fenced(): boolean { return this.current().kind !== 'free'; }

  onOpen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  admit(): RequestAdmission {
    if (this.fenced) return { kind: 'refused' };
    this.inFlight++;
    let released = false;
    return { kind: 'admitted', release: () => {
      if (released) return;
      released = true;
      this.inFlight--;
    } };
  }

  claim(leaseId: string): LeaseClaim {
    if (this.closed) return { kind: 'refused' };
    const state = this.current();
    switch (state.kind) {
      case 'free':
        if (this.inFlight > 0) return { kind: 'refused' };
        return { kind: 'reserved', reservation: this.enter({ kind: 'probing', leaseId, expiresAt: this.deadline() }) };
      case 'probing': return { kind: 'refused' };
      case 'held':
        if (state.leaseId !== leaseId) return { kind: 'refused' };
        return { kind: 'renewed', expiresInMs: this.hold(leaseId) };
      default: return unreachable(state);
    }
  }

  confirm(reservation: LeaseReservation): LeaseConfirmation {
    if (this.closed || this.current() !== reservation) return { kind: 'lost' };
    return { kind: 'held', expiresInMs: this.hold(reservation.leaseId) };
  }

  abandon(reservation: LeaseReservation): void {
    if (this.current() !== reservation) return;
    this.open();
  }

  release(leaseId: string): boolean {
    const state = this.current();
    if (state.kind === 'free' || state.leaseId !== leaseId) return false;
    this.open();
    return true;
  }

  close(): void {
    this.closed = true;
    this.cancelExpiry();
    this.cancelExpiry = noop;
    this.listeners.clear();
  }

  private current(): LeaseState {
    const state = this.state;
    if (state.kind !== 'free' && !this.closed && this.clock.now() >= state.expiresAt) this.open();
    return this.state;
  }

  private deadline(): number { return this.clock.now() + MAINTENANCE_LEASE_MS; }

  private hold(leaseId: string): number {
    this.enter({ kind: 'held', leaseId, expiresAt: this.deadline() });
    return MAINTENANCE_LEASE_MS;
  }

  private enter(next: FencedState): FencedState {
    this.cancelExpiry();
    this.state = next;
    this.cancelExpiry = this.clock.schedule(MAINTENANCE_LEASE_MS, () => {
      if (this.state === next) this.open();
    });
    return next;
  }

  private open(): void {
    this.cancelExpiry();
    this.cancelExpiry = noop;
    this.state = FREE;
    queueMicrotask(() => this.announce());
  }

  private announce(): void {
    if (this.state.kind !== 'free') return;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { continue; }
    }
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled maintenance lease state: ${String(value)}`);
}
