import { TaskService } from './application/task-service.js';
import { openSqliteRepository } from './infrastructure/sqlite/index.js';
import { createAttachmentStore } from './infrastructure/files/index.js';

/** Composition root: concrete infrastructure is wired only at the outside edge. */
export async function openRunnerServices(dataDir: string, runnerId: string) {
  const repository = await openSqliteRepository(dataDir, runnerId);
  try {
    const attachments = await createAttachmentStore(dataDir, runnerId, repository);
    let closing: Promise<void> | undefined;
    return {
      tasks: new TaskService(repository), attachments,
      close(): Promise<void> {
        closing ??= (async () => {
          try { await attachments.close(); }
          finally { await repository.close(); }
        })();
        return closing;
      },
    };
  } catch (error) {
    await repository.close();
    throw error;
  }
}
