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
        case 'reorderThread': value = db.threadMetadata.reorder(...request.args); break;
        case 'getThreadMetadata': value = db.threadMetadata.get(...request.args); break;
        case 'listThreadMetadata': value = db.threadMetadata.list(...request.args); break;
        case 'patchThreadMetadata': value = db.threadMetadata.patch(...request.args); break;
        case 'setTaskSubagents': value = db.setTaskSubagents(...request.args); break;
        case 'releaseSteer': value = db.steering.releaseSteer(...request.args); break;
        case 'claimSteer': value = db.steering.claimSteer(...request.args); break;
        case 'claimPendingSteer': value = db.steering.claimPendingSteer(...request.args); break;
        case 'acceptSteer': value = db.steering.acceptSteer(...request.args); break;
        case 'findSteer': value = db.steering.findSteer(...request.args); break;
        case 'findPendingSteer': value = db.steering.findPendingSteer(...request.args); break;
        case 'createQuestion': value = db.questions.createQuestion(...request.args); break;
        case 'listQuestions': value = db.questions.listQuestions(...request.args); break;
        case 'answerQuestion': value = db.questions.answerQuestion(...request.args); break;
        case 'expireQuestions': value = db.questions.expireQuestions(...request.args); break;
        case 'listArtifactIds': value = db.artifacts.listArtifactIds(); break;
        case 'putArtifact': value = db.artifacts.putArtifact(...request.args); break;
        case 'findArtifact': value = db.artifacts.findArtifact(...request.args); break;
        case 'getArtifact': value = db.artifacts.getArtifact(...request.args); break;
        case 'listArtifacts': value = db.artifacts.listArtifacts(...request.args); break;
        case 'enqueuePending': value = db.pending.enqueuePending(...request.args); break;
        case 'listPending': value = db.pending.listPending(...request.args); break;
        case 'removePending': value = db.pending.removePending(...request.args); break;
        case 'resumePending': value = db.pending.resumePending(...request.args); break;
        case 'promotePending': value = db.pending.promotePending(); break;
        case 'searchHistory': value = db.searchHistory(...request.args); break;
        case 'createClone': value = db.clones.createClone(...request.args); break;
        case 'getClone': value = db.clones.getClone(...request.args); break;
        case 'cancelClone': value = db.clones.cancelClone(...request.args); break;
        case 'claimClone': value = db.clones.claimClone(); break;
        case 'finishClone': value = db.clones.finishClone(...request.args); break;
        case 'interruptClones': value = db.clones.interruptClones(); break;
        case 'listManagedProjects': value = db.clones.listManagedProjects(); break;
        case 'getTaskSession': value = db.getTaskSession(...request.args); break;
        case 'getResumeState': value = db.getResumeState(...request.args); break;
        case 'findContinuation': value = db.findContinuation(...request.args); break;
        case 'continueTask': value = db.continueTask(...request.args); break;
        case 'setTaskSession': value = db.setTaskSession(...request.args); break;
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
