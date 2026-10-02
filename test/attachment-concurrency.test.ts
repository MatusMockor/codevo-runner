import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AttachmentRepository } from '../src/application/ports.js';
import { EXECUTION_LIMITS } from '../src/domain/execution.js';
import { createAttachmentStore } from '../src/infrastructure/files/index.js';
import { createExecutionAttachmentStager } from '../src/infrastructure/files/execution-attachments.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('64 parallel executions stage a shared uploaded attachment without read admission failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-attachments-'));
  const runnerId = randomUUID(); const repository = await openSqliteRepository(root, runnerId);
  const store = await createAttachmentStore(root, runnerId, repository);
  t.after(async () => { await store.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  await store.upload(id, 'prompt.txt', 'text/plain', (async function* () { yield Buffer.from('shared input'); })(), new AbortController().signal);
  const stager = await createExecutionAttachmentStager(root, store);
  const staged = await Promise.all(Array.from({ length: EXECUTION_LIMITS.activeTasks }, () => stager.stage(randomUUID(), [id])));
  assert.equal(new Set(staged.map(result => result.attachments[0]!.path)).size, EXECUTION_LIMITS.activeTasks);
  await Promise.all(staged.map(result => result.cleanup()));
});

test('attachment reads preserve FIFO and bound waiting work; close rejects queued reads and joins active reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'attachment-read-queue-'));
  const entered: string[] = []; const gates = new Map<string, ReturnType<typeof deferred>>();
  const repository: AttachmentRepository = {
    putAttachment: async attachment => ({ attachment, created: true }),
    getAttachment: async id => {
      entered.push(id); await gates.get(id)!.promise;
      return { id, runnerId: randomUUID(), name: 'input.txt', mediaType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
    },
  };
  const store = await createAttachmentStore(root, randomUUID(), repository);
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const ids = Array.from({ length: EXECUTION_LIMITS.activeTasks * 2 + 2 }, () => randomUUID());
  ids.forEach(id => gates.set(id, deferred()));
  const reads = ids.map(id => store.metadata(id));
  reads.forEach(read => { void read.catch(() => undefined); });
  await assert.rejects(store.metadata(randomUUID()), { code: 'busy' });
  assert.deepEqual(entered, ids.slice(0, 2));
  gates.get(ids[0]!)!.resolve(); await reads[0];
  assert.deepEqual(entered, ids.slice(0, 3));
  const closing = store.close(); let closed = false; void closing.then(() => { closed = true; });
  await assert.rejects(reads[3]!, { code: 'storage_unavailable' });
  assert.equal(closed, false);
  gates.get(ids[1]!)!.resolve(); gates.get(ids[2]!)!.resolve();
  await closing;
  const settled = await Promise.allSettled(reads);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(entered, ids.slice(0, 3));
  await assert.rejects(store.metadata(ids[0]!), { code: 'storage_unavailable' });
});
