import type { TerminalSize } from '../domain/terminal.js';
import type { SurfaceWorkspace } from './surface-workspace.js';
import type { OwnedProcess } from '../domain/process-ownership.js';
export interface TerminalProcess {
  write(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
  ownedProcesses(): readonly OwnedProcess[];
}
export interface TerminalProcessFactory {
  open(workspace: SurfaceWorkspace, size: TerminalSize, onData: (data: string) => void, onExit: (exitCode: number | null) => void): Promise<TerminalProcess>;
}
