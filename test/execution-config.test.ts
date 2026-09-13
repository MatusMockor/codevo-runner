import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, readProjectsFile } from '../src/config.js';

test('execution is explicit and supports managed projects without a host registry', () => {
  const base = { CODEVO_TOKEN_FILE: '/token' };
  assert.throws(() => readConfig({ ...base, CODEVO_PROJECTS_ROOT: 'relative' }));
  assert.throws(() => readConfig({ ...base, CODEVO_PROJECTS_ROOT: '' }));
  assert.equal(readConfig({ ...base, CODEVO_PROJECTS_ROOT: '/srv/Developer' }).projectsRoot, '/srv/Developer');
  assert.equal(readConfig(base).executionEnabled, false);
  assert.equal(readConfig(base).executionIsolation, 'provider');
  assert.equal(readConfig({ ...base, CODEVO_EXECUTION_ISOLATION: 'container' }).executionIsolation, 'container');
  assert.throws(() => readConfig({ ...base, CODEVO_EXECUTION_ISOLATION: 'none' }));
  assert.throws(() => readConfig({ ...base, CODEVO_EXECUTION_ENABLED: '1' }));
  assert.equal(readConfig({ ...base, CODEVO_EXECUTION_ENABLED: 'true' }).projectsFile, undefined);
  assert.equal(readConfig({ ...base, CODEVO_EXECUTION_ENABLED: 'true', CODEVO_PROJECTS_FILE: '/projects.json' }).projectsFile, '/projects.json');
});

test('project configuration is bounded, closed, unique and host-local', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'projects.json');
  const project = { id: 'my-app', name: 'My app', path: '/data/projects/my-app' };
  await writeFile(path, JSON.stringify([project]));
  assert.deepEqual(await readProjectsFile(path), [project]);
  for (const value of [[project, project], [{ ...project, path: '../escape' }], [{ ...project, command: 'npm test' }], [{ ...project, id: '../escape' }], Array.from({length:33}, (_,i) => ({...project,id:String(i)}))]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readProjectsFile(path));
  }
  await writeFile(path, '[]');
  assert.deepEqual(await readProjectsFile(path), []);
  await writeFile(path, ' '.repeat(65_537));
  await assert.rejects(readProjectsFile(path));
  const link = join(directory, 'link.json');
  await symlink(path, link);
  await assert.rejects(readProjectsFile(link));
});
