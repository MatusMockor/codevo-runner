import type { RepositoryLookupService } from '../application/repository-lookup-service.js';
import type { ThreadMetadataService } from '../application/thread-metadata.js';
import type { ProjectDirectories } from '../application/project-directories.js';
import type { TerminalService } from '../application/terminal-service.js';
import type { SurfaceService } from '../application/surface-service.js';
import type { QuestionService } from '../application/question-service.js';
import type { ArtifactApplication } from '../application/artifact-ports.js';
import type { HistorySearchApplication } from '../application/history-search.js';
import type { RunnerChangeSource } from '../application/runner-changes.js';
import type { CloneApplication } from '../application/clone-ports.js';
import type { AttachmentStore, TaskApplication } from '../application/ports.js';
import type { ExecutionApplication } from '../application/execution-ports.js';

export interface RunnerServices {
  readonly repositories?: RepositoryLookupService;
  readonly threadMetadata?: ThreadMetadataService;
  readonly projectDirectories?: ProjectDirectories;
  readonly surfaces?: SurfaceService;
  readonly terminals?: TerminalService;
  readonly questions?: QuestionService;
  readonly artifacts?: ArtifactApplication;
  readonly historySearch?: HistorySearchApplication;
  readonly changes?: RunnerChangeSource;
  readonly clones?: CloneApplication;
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
