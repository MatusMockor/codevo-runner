import type { AttachmentStore, TaskApplication } from '../application/ports.js';
import type { ExecutionApplication } from '../application/execution-ports.js';

export interface RunnerServices {
  readonly tasks: TaskApplication;
  readonly attachments: AttachmentStore;
  readonly execution?: ExecutionApplication;
  readonly close: () => Promise<void>;
}
export const SERVICES = Symbol('runner services');
export const DESCRIPTOR = Symbol('runner descriptor');
export const AUTHORIZE = Symbol('runner authorization');
export const EXTENDED = Symbol('extended runner routes');
export type Authorize = (header: string | undefined) => boolean;
