import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCloneInput } from '../src/domain/project-clone.js';
import { ManagedProjectRegistry } from '../src/application/project-clone-service.js';
import { ConfiguredProjectRegistry } from '../src/infrastructure/projects/index.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';

test('clone inputs reject credential, command, path and newline ambiguity', () => {
  const input = { idempotencyKey: randomUUID(), name: 'app', url: 'git@example.com:team/app.git' };
  assert.deepEqual(parseCloneInput(input), input);
  for (const url of ['https://a/b\n', 'https://u:password@a/b', 'https://a/b?token=secret', 'file:///tmp/a', 'ext::command', 'ssh://git@a:0/b', 'git@a:../b']) {
    assert.throws(() => parseCloneInput({ ...input, url }), { code: 'invalid_input' });
  }
  for (const branch of ['-evil', 'a..b', 'a.lock', '.hidden/a', 'a\n', 'a@{b', 'a//b']) {
    assert.throws(() => parseCloneInput({ ...input, branch }), { code: 'invalid_input' });
  }
  assert.throws(() => parseCloneInput({ ...input, name: 'app\n' }), { code: 'invalid_input' });
  assert.throws(() => parseCloneInput({ ...input, idempotencyKey: `${input.idempotencyKey}\n` }), { code: 'invalid_input' });
});

test('a configured project cannot remap a persisted managed project identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clone-policy-'));
  const repository = await openSqliteRepository(directory, randomUUID());
  try {
    const job = await repository.createClone({ idempotencyKey: randomUUID(), name: 'app', url: 'https://example.com/app' });
    await repository.claimClone();
    await assert.rejects(repository.finishClone(job.id, 'succeeded', { id: 'wrong', name: 'app', path: '/tmp/app' }, null), { code: 'invalid_input' });
    const project = { id: 'app', name: 'app', path: '/tmp/app' };
    await repository.finishClone(job.id, 'succeeded', project, null);
    const conflicting = new ManagedProjectRegistry(new ConfiguredProjectRegistry([{ ...project, path: '/tmp/other' }]), repository);
    await assert.rejects(conflicting.list(), { code: 'conflict' });
    await assert.rejects(conflicting.get('app'), { code: 'conflict' });
    const identical = new ManagedProjectRegistry(new ConfiguredProjectRegistry([project]), repository);
    assert.deepEqual(await identical.list(), [{ id: 'app', name: 'app' }]);
    assert.deepEqual(await identical.get('app'), project);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
