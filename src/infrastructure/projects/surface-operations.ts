import type { SurfaceOperations } from '../../application/surface-service.js';
import type { SurfaceWorkspace } from '../../application/surface-workspace.js';
import type { SurfaceInput, SurfaceOperation } from '../../domain/surface-files.js';
import { surfaceFiles } from './surface-files.js';
import { listSurfaceHistory, listSurfaceCommitFiles, readSurfaceCommitDiff } from './surface-history.js';
export class FileSystemSurfaceOperations implements SurfaceOperations {
  perform(workspace: SurfaceWorkspace, operation: SurfaceOperation, input: SurfaceInput, signal: AbortSignal) {
    switch (operation) {
      case 'tree': case 'read': case 'write': return surfaceFiles(workspace, operation, input, signal);
      case 'history': return listSurfaceHistory(workspace.cwd, workspace.identity, { offset: input.offset! }, signal);
      case 'commit-files': return listSurfaceCommitFiles(workspace.cwd, workspace.identity, { commit: input.commit! }, signal);
      case 'commit-diff': return readSurfaceCommitDiff(workspace.cwd, workspace.identity, { commit: input.commit!, path: input.path! }, signal);
    }
  }
}
