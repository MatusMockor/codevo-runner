import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OBSERVATION_DIAGNOSTIC_LIMIT, OBSERVATION_FAILURE_BUDGET, OBSERVATION_FAILURE_LIMIT, OBSERVATION_INTERVAL_MS, OBSERVATION_START,
  PERMANENT_ERRNOS, PROCESS_TREE_LIMIT,
  classifyProcessFailure, cleanupDiagnostic, decideObservation, processDiagnosticNote, processDiagnosticNotes, trackObservation,
  type ProcessDiagnostic,
} from '../src/domain/process-observation.js';

const SECRET = '/data/provider-home/.codex/token';
const errno = (code: string) => Object.assign(new Error(`${code}: no such process, open '${SECRET}'`), { code });
const limit = () => new Error(PROCESS_TREE_LIMIT);
const repeat = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

function drive(script: readonly (Error | undefined)[], ticks = script.length) {
  const reports: ProcessDiagnostic[] = [];
  let failed = 0;
  let observed = 0;
  const tick = trackObservation(() => {
    const error = script[observed++];
    if (error) throw error;
  }, diagnostic => { reports.push(diagnostic); }, () => { failed++; });
  for (let index = 0; index < ticks; index++) tick();
  return { reports, failed, observed };
}

test('observation bound tolerates about five seconds of consecutive failures', () => {
  assert.equal(OBSERVATION_FAILURE_LIMIT, 50);
  assert.equal(OBSERVATION_FAILURE_LIMIT * OBSERVATION_INTERVAL_MS, 5000);
  assert.equal(OBSERVATION_FAILURE_BUDGET, 600);
  assert.equal(OBSERVATION_FAILURE_BUDGET * OBSERVATION_INTERVAL_MS, 60000);
});

test('errno failures split into a closed permanent set and transient everything else', () => {
  assert.deepEqual([...PERMANENT_ERRNOS].sort(), ['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOTDIR', 'EPERM']);
  for (const code of PERMANENT_ERRNOS) {
    assert.deepEqual(classifyProcessFailure(errno(code)), { kind: 'permanent', cause: code });
    const { reports, failed, observed } = drive([errno('EIO'), errno(code), undefined]);
    assert.equal(failed, 1);
    assert.equal(observed, 2);
    assert.deepEqual(reports.at(-1), { phase: 'observe', cause: code, outcome: 'failed', consecutive: 2, total: 2 });
  }
  for (const code of ['ESRCH', 'ENOENT', 'EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'EINTR', 'EAGAIN', 'EBUSY', 'ENOBUFS']) {
    assert.deepEqual(classifyProcessFailure(errno(code)), { kind: 'transient', cause: code });
    assert.equal(drive([errno(code), errno(code), undefined]).failed, 0);
  }
});

test('process failures classify into a closed set without raw exception text', () => {
  assert.deepEqual(classifyProcessFailure(errno('ESRCH')), { kind: 'transient', cause: 'ESRCH' });
  assert.deepEqual(classifyProcessFailure(errno('EMFILE')), { kind: 'transient', cause: 'EMFILE' });
  assert.deepEqual(classifyProcessFailure(limit()), { kind: 'limit', cause: PROCESS_TREE_LIMIT });
  assert.deepEqual(classifyProcessFailure(Object.assign(limit(), { code: 'EIO' })), { kind: 'limit', cause: PROCESS_TREE_LIMIT });
  assert.deepEqual(classifyProcessFailure(new TypeError(SECRET)), { kind: 'unexpected', cause: 'TypeError' });
  assert.deepEqual(classifyProcessFailure(Object.assign(new TypeError(SECRET), { code: 'ERR_INVALID_ARG_TYPE' })),
    { kind: 'unexpected', cause: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual(classifyProcessFailure(Object.assign(new Error(SECRET), { code: SECRET })), { kind: 'unexpected', cause: 'Error' });
  assert.deepEqual(classifyProcessFailure(Object.assign(new Error(SECRET), { code: 5, name: SECRET })), { kind: 'unexpected', cause: 'unknown' });
  for (const thrown of [SECRET, null, undefined, 7, { code: 'EIO' }]) {
    assert.deepEqual(classifyProcessFailure(thrown), { kind: 'unexpected', cause: 'unknown' });
  }
});

test('a transient observation failure is tolerated and reported once per streak', () => {
  const { reports, failed, observed } = drive([errno('ESRCH'), errno('EIO'), errno('EIO'), undefined, undefined]);
  assert.equal(failed, 0);
  assert.equal(observed, 5);
  assert.deepEqual(reports, [{ phase: 'observe', cause: 'ESRCH', outcome: 'retrying', consecutive: 1, total: 1 }]);
});

test('a successful observation resets the failure streak', () => {
  const almost = repeat(OBSERVATION_FAILURE_LIMIT - 1, errno('EIO'));
  const { reports, failed, observed } = drive([...almost, undefined, ...almost, undefined]);
  assert.equal(failed, 0);
  assert.equal(observed, 2 * OBSERVATION_FAILURE_LIMIT);
  assert.deepEqual(reports.map(report => report.outcome), ['retrying', 'retrying']);
});

test('consecutive observation failures fail the run exactly at the bound and then stop observing', () => {
  const script = [...repeat(OBSERVATION_FAILURE_LIMIT - 1, errno('EIO')), errno('EMFILE')];
  const before = drive(script, OBSERVATION_FAILURE_LIMIT - 1);
  assert.equal(before.failed, 0);
  const { reports, failed, observed } = drive(script, OBSERVATION_FAILURE_LIMIT + 25);
  assert.equal(failed, 1);
  assert.equal(observed, OBSERVATION_FAILURE_LIMIT);
  assert.deepEqual(reports, [
    { phase: 'observe', cause: 'EIO', outcome: 'retrying', consecutive: 1, total: 1 },
    { phase: 'observe', cause: 'EMFILE', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT, total: OBSERVATION_FAILURE_LIMIT },
  ]);
});

test('flapping observation failures exhaust the cumulative budget while healthy ticks do not consume it', () => {
  const flapping = (failures: number) => repeat(failures, [errno('EIO'), undefined]).flat();
  const healthy = drive([...repeat(10 * OBSERVATION_FAILURE_BUDGET, undefined), ...flapping(OBSERVATION_FAILURE_BUDGET - 1)]);
  assert.equal(healthy.failed, 0);
  assert.equal(healthy.observed, 12 * OBSERVATION_FAILURE_BUDGET - 2);
  const { reports, failed, observed } = drive(flapping(OBSERVATION_FAILURE_BUDGET + 40));
  assert.equal(failed, 1);
  assert.equal(observed, 2 * OBSERVATION_FAILURE_BUDGET - 1);
  assert.deepEqual(reports.at(-1), { phase: 'observe', cause: 'EIO', outcome: 'exhausted', consecutive: 1, total: OBSERVATION_FAILURE_BUDGET });
  assert.equal(reports.length, OBSERVATION_DIAGNOSTIC_LIMIT + 1);
});

test('the process tree limit and unexpected failures are immediately fatal', () => {
  for (const [error, cause] of [[limit(), PROCESS_TREE_LIMIT], [new RangeError(SECRET), 'RangeError']] as const) {
    const first = drive([error, undefined, undefined]);
    assert.equal(first.failed, 1);
    assert.equal(first.observed, 1);
    assert.deepEqual(first.reports, [{ phase: 'observe', cause, outcome: 'failed', consecutive: 1, total: 1 }]);
    const later = drive([errno('EIO'), errno('EIO'), error, undefined]);
    assert.equal(later.failed, 1);
    assert.equal(later.observed, 3);
    assert.deepEqual(later.reports.at(-1), { phase: 'observe', cause, outcome: 'failed', consecutive: 3, total: 3 });
  }
});

test('retry diagnostics are capped per run while the final failure is always reported', () => {
  const flapping = repeat(OBSERVATION_DIAGNOSTIC_LIMIT + 12, [errno('EIO'), undefined]).flat();
  const { reports, failed } = drive([...flapping, ...repeat(OBSERVATION_FAILURE_LIMIT, errno('EIO'))]);
  assert.equal(failed, 1);
  assert.equal(reports.filter(report => report.outcome === 'retrying').length, OBSERVATION_DIAGNOSTIC_LIMIT);
  assert.deepEqual(reports.at(-1), { phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT,
    total: OBSERVATION_DIAGNOSTIC_LIMIT + 12 + OBSERVATION_FAILURE_LIMIT });
  assert.equal(reports.length, OBSERVATION_DIAGNOSTIC_LIMIT + 1);
});

test('the observation decision is a pure transition over an immutable state', () => {
  const transient = classifyProcessFailure(errno('EIO'));
  assert.deepEqual(decideObservation(OBSERVATION_START, undefined), { kind: 'healthy', next: { streak: 0, failed: 0, reported: 0 } });
  assert.deepEqual(decideObservation(OBSERVATION_START, transient), { kind: 'tolerated', next: { streak: 1, failed: 1, reported: 1 },
    diagnostic: { phase: 'observe', cause: 'EIO', outcome: 'retrying', consecutive: 1, total: 1 } });
  assert.deepEqual(decideObservation({ streak: 1, failed: 1, reported: 1 }, transient),
    { kind: 'tolerated', next: { streak: 2, failed: 2, reported: 1 } });
  assert.deepEqual(decideObservation({ streak: 7, failed: 9, reported: 3 }, undefined),
    { kind: 'healthy', next: { streak: 0, failed: 9, reported: 3 } });
  assert.deepEqual(decideObservation({ streak: 0, failed: 20, reported: OBSERVATION_DIAGNOSTIC_LIMIT }, transient),
    { kind: 'tolerated', next: { streak: 1, failed: 21, reported: OBSERVATION_DIAGNOSTIC_LIMIT } });
  assert.equal(decideObservation({ streak: OBSERVATION_FAILURE_LIMIT - 2, failed: 60, reported: 1 }, transient).kind, 'tolerated');
  assert.deepEqual(decideObservation({ streak: OBSERVATION_FAILURE_LIMIT - 1, failed: 60, reported: 1 }, transient), { kind: 'fatal',
    diagnostic: { phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT, total: 61 } });
  assert.equal(decideObservation({ streak: 0, failed: OBSERVATION_FAILURE_BUDGET - 2, reported: 1 }, transient).kind, 'tolerated');
  assert.deepEqual(decideObservation({ streak: 3, failed: OBSERVATION_FAILURE_BUDGET - 1, reported: 1 }, transient), { kind: 'fatal',
    diagnostic: { phase: 'observe', cause: 'EIO', outcome: 'exhausted', consecutive: 4, total: OBSERVATION_FAILURE_BUDGET } });
  assert.deepEqual(decideObservation({ streak: OBSERVATION_FAILURE_LIMIT - 1, failed: OBSERVATION_FAILURE_BUDGET - 1, reported: 1 }, transient),
    { kind: 'fatal', diagnostic: { phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT,
      total: OBSERVATION_FAILURE_BUDGET } });
  assert.equal(decideObservation(OBSERVATION_START, classifyProcessFailure(limit())).kind, 'fatal');
  assert.equal(decideObservation(OBSERVATION_START, classifyProcessFailure(errno('EACCES'))).kind, 'fatal');
  assert.deepEqual(OBSERVATION_START, { streak: 0, failed: 0, reported: 0 });
});

test('diagnostic notes carry only the phase and a bounded cause', () => {
  assert.equal(processDiagnosticNote({ phase: 'observe', cause: 'ESRCH', outcome: 'retrying', consecutive: 1, total: 4 }),
    '[Codevo] Process tree observe failed; retrying (ESRCH).\n');
  assert.equal(processDiagnosticNote({ phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT, total: 70 }),
    '[Codevo] Process tree observe failed (EIO, 50 consecutive).\n');
  assert.equal(processDiagnosticNote({ phase: 'observe', cause: 'EIO', outcome: 'exhausted', consecutive: 3, total: OBSERVATION_FAILURE_BUDGET }),
    '[Codevo] Process tree observe failed (EIO, 600 total).\n');
  assert.equal(processDiagnosticNote({ phase: 'observe', cause: PROCESS_TREE_LIMIT, outcome: 'failed', consecutive: 1, total: 1 }),
    '[Codevo] Process tree observe failed (process_tree_limit).\n');
  assert.equal(processDiagnosticNote(cleanupDiagnostic('kill', errno('EPERM'))), '[Codevo] Process tree kill failed (EPERM).\n');
  assert.equal(processDiagnosticNote(cleanupDiagnostic('attach', new Error(SECRET))), '[Codevo] Process tree attach failed (Error).\n');
  for (const thrown of [errno('EIO'), new Error(SECRET), Object.assign(new Error(SECRET), { code: SECRET, name: SECRET }), SECRET]) {
    const note = processDiagnosticNote(cleanupDiagnostic('kill', thrown));
    assert.ok(!note.includes(SECRET));
    assert.ok(Buffer.byteLength(note) <= 128);
  }
});

test('repeated kill failures are reported once per run', () => {
  const notes: string[] = [];
  const report = processDiagnosticNotes(note => { notes.push(note); });
  report(cleanupDiagnostic('kill', errno('EPERM')));
  report({ phase: 'observe', cause: 'EIO', outcome: 'retrying', consecutive: 1, total: 1 });
  report(cleanupDiagnostic('kill', errno('EACCES')));
  report({ phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT, total: OBSERVATION_FAILURE_LIMIT });
  assert.deepEqual(notes, [
    '[Codevo] Process tree kill failed (EPERM).\n',
    '[Codevo] Process tree observe failed; retrying (EIO).\n',
    '[Codevo] Process tree observe failed (EIO, 50 consecutive).\n',
  ]);
});

test('a closed run emits no further diagnostics', () => {
  const notes: string[] = [];
  let open = true;
  const report = processDiagnosticNotes(note => { notes.push(note); }, () => open);
  report({ phase: 'observe', cause: 'EIO', outcome: 'retrying', consecutive: 1, total: 1 });
  open = false;
  report(cleanupDiagnostic('kill', errno('EPERM')));
  report({ phase: 'observe', cause: 'EIO', outcome: 'failed', consecutive: OBSERVATION_FAILURE_LIMIT, total: OBSERVATION_FAILURE_LIMIT });
  assert.deepEqual(notes, ['[Codevo] Process tree observe failed; retrying (EIO).\n']);
});
