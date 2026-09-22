import type { TurnChangesSummary, TurnFileDiff } from '../domain/turn-changes.js';
/** Immutable snapshots belong to one actual provider turn, including continuations. */
export interface TurnChanges {
  captureStart(taskId: string, cwd: string, identity: Readonly<{ dev: number; ino: number }>, signal: AbortSignal): Promise<void>;
  captureEnd(taskId: string, cwd: string, identity: Readonly<{ dev: number; ino: number }>, signal: AbortSignal): Promise<void>;
  summary(taskId: string): Promise<TurnChangesSummary>;
  diff(taskId: string, relativePath: string): Promise<TurnFileDiff>;
}
