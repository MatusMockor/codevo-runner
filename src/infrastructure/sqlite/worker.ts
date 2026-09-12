import { parentPort, workerData } from 'node:worker_threads';
import { RunnerError, type ErrorCode } from '../../domain/contracts.js';
import { RepositoryDatabase } from './database.js';
import type { Request } from './protocol.js';
function errorCode(error: unknown): ErrorCode {
  if (error instanceof RunnerError) return error.code;
  if (error instanceof Error && /database is (locked|busy)/i.test(error.message)) return 'busy';
  if (error instanceof Error && /database or disk is full/i.test(error.message)) return 'quota_exceeded';
  return 'storage_unavailable';
}
try {
  const db = new RepositoryDatabase(workerData.dataDir as string, workerData.runnerId as string);
  parentPort!.on('message', (request: Request) => {
    try {
      let value: unknown;
      switch (request.method) {
        case 'createTask': value = db.createTask(...request.args); break;
        case 'getTask': value = db.getTask(...request.args); break;
        case 'listTasks': value = db.listTasks(...request.args); break;
        case 'cancelTask': value = db.cancelTask(...request.args); break;
        case 'listEvents': value = db.listEvents(...request.args); break;
        case 'putAttachment': value = db.putAttachment(...request.args); break;
        case 'getAttachment': value = db.getAttachment(...request.args); break;
        case 'queueTask': value = db.queueTask(...request.args); break;
        case 'claimNextTask': value = db.claimNextTask(); break;
        case 'appendTaskOutput': value = db.appendTaskOutput(...request.args); break;
        case 'finishTask': value = db.finishTask(...request.args); break;
        case 'interruptRunningTasks': value = db.interruptRunningTasks(); break;
        case 'close': db.close(); break;
        default: throw new RunnerError('invalid_input');
      }
      parentPort!.postMessage({ id: request.id, value });
      if (request.method === 'close') parentPort!.close();
    } catch (error) { parentPort!.postMessage({ id: request.id, error: errorCode(error) }); }
  });
  parentPort!.postMessage({ id: 0 });
} catch (error) {
  parentPort!.postMessage({ id: 0, error: errorCode(error) });
  parentPort!.close();
}
