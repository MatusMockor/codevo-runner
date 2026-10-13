import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

test('management discovery preserves the strict legacy descriptor and negotiates each feature independently', async t => {
  const runnerId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'runner-negotiation-'));
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [] });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Negotiation test',
    capabilities: { taskExecution: false, eventReplay: true, projectManagement: true, threadManagement: true } },
  value => value === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1/runner`;
  const get = async (capabilities?: string) => {
    const response = await fetch(url, { headers: { authorization: 'Bearer test',
      ...(capabilities === undefined ? {} : { 'x-codevo-client-capabilities': capabilities }) } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const legacy = (await get()).capabilities;
  assert.equal('projectManagement' in legacy, false);
  assert.equal('threadManagement' in legacy, false);
  assert.equal('turnChanges' in legacy, false);
  assert.equal('fileAttachments' in legacy, false);
  assert.deepEqual([legacy.imageAttachments, legacy.textAttachments], [true, true]);
  assert.deepEqual((await get('fileAttachments')).capabilities, { ...legacy, fileAttachments: true });
  assert.deepEqual((await get('subagentLifecycleRetention, fileAttachments ,turnChanges')).capabilities, { ...legacy, turnChanges: true, fileAttachments: true });
  for (const header of ['fileattachments', 'FileAttachments', 'fileAttachments2', 'file-attachments', 'imageAttachments,textAttachments'])
    assert.deepEqual((await get(header)).capabilities, legacy, header);
  for (const header of [undefined, 'subagentLifecycleRetention', 'projectmanagement', 'x'.repeat(513), Array(17).fill('threadManagement').join(',')]) {
    assert.deepEqual((await get(header)).capabilities, legacy);
  }
  assert.deepEqual((await get('turnChanges')).capabilities, { ...legacy, turnChanges: true });
  assert.deepEqual((await get('projectManagement')).capabilities, { ...legacy, projectManagement: true });
  assert.deepEqual((await get('threadManagement')).capabilities, { ...legacy, threadManagement: true });
  assert.deepEqual((await get('subagentLifecycleRetention, projectManagement, threadManagement')).capabilities,
    { ...legacy, projectManagement: true, threadManagement: true });
  assert.equal((await fetch(url, { headers: { 'x-codevo-client-capabilities': 'projectManagement,threadManagement' } })).status, 401);
});

 test('discovery-only mode never advertises unavailable management services', async t => {
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId: randomUUID(), name: 'Discovery only',
    capabilities: { taskExecution: false, eventReplay: true, projectManagement: true, threadManagement: true } }, () => true);
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1/runner`;
  const descriptor = await (await fetch(url, { headers: { 'x-codevo-client-capabilities': 'projectManagement,threadManagement' } })).json();
  assert.equal(descriptor.capabilities.projectManagement, false);
  assert.equal(descriptor.capabilities.threadManagement, false);
  assert.equal('fileAttachments' in descriptor.capabilities, false);
  const announced = await (await fetch(url, { headers: { 'x-codevo-client-capabilities': 'fileAttachments' } })).json();
  assert.equal(announced.capabilities.fileAttachments, false);
  const silent = await (await fetch(url)).json();
  assert.equal('fileAttachments' in silent.capabilities, false);
});

test('folderProjects is announced only to clients that understand it and only when registration is offered', async t => {
  const runnerId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'runner-folder-negotiation-'));
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [], projectsRoot: join(root, 'projects'), providers: [] });
  const stored = await openRunnerServices(join(root, 'stored'), runnerId);
  const descriptor = { protocolVersion: 1 as const, runnerId, name: 'Folder negotiation', capabilities: { taskExecution: false, eventReplay: true, folderProjects: true } };
  const apps = [await createRunnerApplication(descriptor, value => value === 'Bearer test', services), await createRunnerApplication(descriptor, value => value === 'Bearer test', stored),
    await createRunnerApplication(descriptor, value => value === 'Bearer test')];
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const capabilities = async (app: typeof apps[number], header?: string) => {
    if (!app.getHttpServer().listening) await app.listen(0, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1/runner`, { headers: { authorization: 'Bearer test',
      ...(header === undefined ? {} : { 'x-codevo-client-capabilities': header }) } });
    assert.equal(response.status, 200);
    return (await response.json() as { capabilities: Record<string, unknown> }).capabilities;
  };
  const [executing, storing, discovering] = apps as [typeof apps[number], typeof apps[number], typeof apps[number]];
  const legacy = await capabilities(executing);
  assert.equal('folderProjects' in legacy, false);
  assert.deepEqual(await capabilities(executing, 'folderProjects'), { ...legacy, folderProjects: true });
  assert.deepEqual(await capabilities(executing, 'fileAttachments, folderProjects'), { ...legacy, fileAttachments: true, folderProjects: true });
  for (const header of ['folderprojects', 'FolderProjects', 'folderProjects2', 'folder-projects', 'projectManagement'])
    assert.equal('folderProjects' in await capabilities(executing, header), false, header);
  for (const app of [storing, discovering]) {
    assert.equal('folderProjects' in await capabilities(app), false);
    assert.equal((await capabilities(app, 'folderProjects')).folderProjects, false);
  }
});
