import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RegisteredSurfaceWorkspaceResolver } from '../src/infrastructure/projects/surface-workspace.js';
import { ConfiguredProjectRegistry } from '../src/infrastructure/projects/index.js';
import type { Task } from '../src/domain/contracts.js';
import type { ProjectWorkspace } from '../src/application/execution-ports.js';
const unsupported = async (): Promise<never> => { throw new Error('unexpected'); };
test('surface resolver binds registered project and rejects foreign task instead of fallback', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'surface-context-'));
  const isolated = await mkdtemp(join(tmpdir(), 'surface-task-'));
  const taskId = randomUUID(); const ancestorId = randomUUID();
  let foreign = false;
  const tasks = { getTask: async (id: string): Promise<Task> => ({ id, sequence: 1, runnerId: randomUUID(), provider: 'claude', status: 'succeeded', projectId: foreign ? 'other' : 'project', parts: [], createdAt: '' }) };
  const workspace: ProjectWorkspace = { prepare: unsupported, diff: unsupported, files: unsupported, fileDiff: unsupported, resume: async (_project, id) => { assert.equal(id, ancestorId); return isolated; } };
  const resolver = new RegisteredSurfaceWorkspaceResolver(new ConfiguredProjectRegistry([{ id: 'project', name: 'Project', path: cwd }]), workspace, tasks, { getTaskSession: async () => ({ workspaceTaskId: ancestorId, sessionId: null }) });
  try {
    assert.equal((await resolver.resolve('project')).cwd, await realpath(cwd));
    assert.equal((await resolver.resolve('project', taskId)).cwd, isolated);
    foreign = true;
    await assert.rejects(resolver.resolve('project', taskId), /not_found/);
    foreign = false;
    const lease = await resolver.resolve('project');
    await rename(cwd, `${cwd}-moved`); await mkdir(cwd);
    await assert.rejects(lease.revalidate(), /conflict/);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(`${cwd}-moved`, { recursive: true, force: true }); await rm(isolated, { recursive: true, force: true }); }
});
