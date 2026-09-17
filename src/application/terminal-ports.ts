import type { TerminalSize } from '../domain/terminal.js';
import type { SurfaceWorkspace } from './surface-workspace.js';
export interface TerminalProcess {
  write(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
}
export interface TerminalProcessFactory {
  open(workspace: SurfaceWorkspace, size: TerminalSize, onData: (data: string) => void, onExit: (exitCode: number | null) => void): Promise<TerminalProcess>;
}
