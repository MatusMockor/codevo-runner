export const OBSERVATION_INTERVAL_MS = 100;
export const OBSERVATION_FAILURE_LIMIT = 50;
export const OBSERVATION_FAILURE_BUDGET = 600;
export const OBSERVATION_DIAGNOSTIC_LIMIT = 8;
export const PROCESS_TREE_LIMIT = 'process_tree_limit';
export const PERMANENT_ERRNOS: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

export type ProcessFailure = Readonly<{ kind: 'transient' | 'permanent' | 'limit' | 'unexpected'; cause: string }>;
export type ProcessDiagnostic = Readonly<{
  phase: 'attach' | 'observe' | 'kill'; cause: string; outcome: 'retrying' | 'failed' | 'exhausted'; consecutive: number; total: number;
}>;
export type ProcessDiagnosticSink = (diagnostic: ProcessDiagnostic) => void;
export type ObservationState = Readonly<{ streak: number; failed: number; reported: number }>;
export type ObservationDecision =
  | Readonly<{ kind: 'healthy'; next: ObservationState }>
  | Readonly<{ kind: 'tolerated'; next: ObservationState; diagnostic?: ProcessDiagnostic }>
  | Readonly<{ kind: 'fatal'; diagnostic: ProcessDiagnostic }>;

export const OBSERVATION_START: ObservationState = { streak: 0, failed: 0, reported: 0 };

const ERRNO = /^E[A-Z0-9]{1,15}$/;
const LABEL = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export function classifyProcessFailure(error: unknown): ProcessFailure {
  if (error instanceof Error && error.message === PROCESS_TREE_LIMIT) return { kind: 'limit', cause: PROCESS_TREE_LIMIT };
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && PERMANENT_ERRNOS.has(code)) return { kind: 'permanent', cause: code };
  if (typeof code === 'string' && ERRNO.test(code)) return { kind: 'transient', cause: code };
  if (typeof code === 'string' && LABEL.test(code)) return { kind: 'unexpected', cause: code };
  if (error instanceof Error && LABEL.test(error.name)) return { kind: 'unexpected', cause: error.name };
  return { kind: 'unexpected', cause: 'unknown' };
}

export function outranksProcessFailure(candidate: unknown, current: unknown): boolean {
  return classifyProcessFailure(candidate).kind !== 'transient' && classifyProcessFailure(current).kind === 'transient';
}

export function decideObservation(state: ObservationState, failure: ProcessFailure | undefined): ObservationDecision {
  if (!failure) return { kind: 'healthy', next: { ...state, streak: 0 } };
  const consecutive = state.streak + 1;
  const total = state.failed + 1;
  const diagnostic = (outcome: ProcessDiagnostic['outcome']): ProcessDiagnostic =>
    ({ phase: 'observe', cause: failure.cause, outcome, consecutive, total });
  switch (failure.kind) {
    case 'permanent':
    case 'limit':
    case 'unexpected':
      return { kind: 'fatal', diagnostic: diagnostic('failed') };
    case 'transient': {
      if (consecutive >= OBSERVATION_FAILURE_LIMIT) return { kind: 'fatal', diagnostic: diagnostic('failed') };
      if (total >= OBSERVATION_FAILURE_BUDGET) return { kind: 'fatal', diagnostic: diagnostic('exhausted') };
      const next = { ...state, streak: consecutive, failed: total };
      if (consecutive > 1 || state.reported >= OBSERVATION_DIAGNOSTIC_LIMIT) return { kind: 'tolerated', next };
      return { kind: 'tolerated', next: { ...next, reported: state.reported + 1 }, diagnostic: diagnostic('retrying') };
    }
    default:
      return unreachable(failure.kind);
  }
}

export function trackObservation(observe: () => void, report: ProcessDiagnosticSink, fail: () => void): () => void {
  let state: ObservationState | undefined = OBSERVATION_START;
  return () => {
    if (!state) return;
    const decision = decideObservation(state, attempt(observe));
    switch (decision.kind) {
      case 'healthy':
        state = decision.next;
        return;
      case 'tolerated':
        state = decision.next;
        if (decision.diagnostic) report(decision.diagnostic);
        return;
      case 'fatal':
        state = undefined;
        report(decision.diagnostic);
        fail();
        return;
      default:
        unreachable(decision);
    }
  };
}

export function cleanupDiagnostic(phase: 'attach' | 'kill', error: unknown): ProcessDiagnostic {
  return { phase, cause: classifyProcessFailure(error).cause, outcome: 'failed', consecutive: 1, total: 1 };
}

export function processDiagnosticNote(diagnostic: ProcessDiagnostic): string {
  const retry = diagnostic.outcome === 'retrying' ? '; retrying' : '';
  const streak = diagnostic.consecutive > 1 ? `, ${diagnostic.consecutive} consecutive` : '';
  const count = diagnostic.outcome === 'exhausted' ? `, ${diagnostic.total} total` : streak;
  return `[Codevo] Process tree ${diagnostic.phase} failed${retry} (${diagnostic.cause}${count}).\n`;
}

export function processDiagnosticNotes(emit: (note: string) => void, open: () => boolean = () => true): ProcessDiagnosticSink {
  let killReported = false;
  return diagnostic => {
    if (!open()) return;
    if (diagnostic.phase === 'kill' && killReported) return;
    if (diagnostic.phase === 'kill') killReported = true;
    emit(processDiagnosticNote(diagnostic));
  };
}

function attempt(observe: () => void): ProcessFailure | undefined {
  try { observe(); return undefined; }
  catch (error) { return classifyProcessFailure(error); }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled process observation variant: ${String(value)}`);
}
