import type { ListeningPort, PortList, PortSource } from '../domain/port-preview.js';
import type { OwnedProcess } from '../domain/process-ownership.js';

export interface PortPreviewApplication {
  taskPorts(taskId: string): Promise<PortList>;
  projectPorts(projectId: string): Promise<PortList>;
}

export type PortOwner = Readonly<{ source: PortSource; processes: readonly OwnedProcess[]; complete: boolean }>;
export type PortScan = Readonly<{ ports: readonly ListeningPort[]; truncated: boolean }>;

export interface ListeningPortScanner {
  scan(owners: readonly PortOwner[], signal: AbortSignal): Promise<PortScan>;
}
