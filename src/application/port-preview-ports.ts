import type { PortList } from '../domain/port-preview.js';

export interface PortPreviewApplication {
  taskPorts(taskId: string): Promise<PortList>;
  projectPorts(projectId: string): Promise<PortList>;
}
