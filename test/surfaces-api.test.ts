import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { TerminalService } from '../src/application/terminal-service.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';
const exec = promisify(execFile);
const authorization = 'Bearer surface-http-test';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-surface-api-'));
  const source = join(root, 'source'); await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'tracked.txt'), 'initial\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, { projects: [{ id: 'sample', name: 'Sample', path: source }], providers: [] });
  const writes: string[] = [];
  const terminals = new TerminalService({ async resolve() { return { cwd: source, identity: { dev: 1, ino: 1 }, async revalidate() {} }; } }, {
    async open(_workspace, _size, data) { data('ready\r\n'); return { write(value) { writes.push(value); }, resize() {}, close() {} }; },
  });
  const app = await createRunnerApplication({ runnerId, name: 'Surface test', protocolVersion: 1, capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, { ...services, terminals, async close() { await terminals.close(); await services.close(); } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string,string> = {}) => fetch(url + path, { method, headers: { authorization, 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, source, writes };
}
test('surface HTTP routes authenticate, enforce identity and support real files/history', async t => {
  const { request, source } = await fixture(t);
  const base = '/v1/projects/sample/surface';
  assert.equal((await request(`${base}/capabilities`, 'GET', undefined, { authorization: '' })).status, 401);
  assert.equal((await request(`${base}/capabilities`, 'GET', undefined, { 'x-codevo-runner-id': randomUUID() })).status, 409);
  assert.deepEqual(await (await request(`${base}/capabilities`)).json(), { files: true, history: true, terminal: true });
  assert.equal((await request(`${base}/capabilities`, 'POST', {})).status, 405);
  const tree = await request(`${base}/tree`, 'POST', { path: '', offset: 0 }); assert.equal(tree.status, 200);
  assert.ok((await tree.json()).entries.some((entry: {path: string}) => entry.path === 'tracked.txt'));
  const original = await (await request(`${base}/read`, 'POST', { path: 'tracked.txt' })).json();
  assert.equal(original.text, 'initial\n');
  const saved = await request(`${base}/write`, 'POST', { path: 'tracked.txt', text: 'saved\n', expectedVersion: original.version }); assert.equal(saved.status, 200);
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'saved\n');
  assert.equal((await request(`${base}/write`, 'POST', { path: 'tracked.txt', text: 'stale\n', expectedVersion: original.version })).status, 409);
  const history = await (await request(`${base}/history`, 'POST', { offset: 0 })).json();
  assert.equal(history.commits[0].subject, 'initial');
  const commit = history.commits[0].id;
  assert.equal((await request(`${base}/commit-files`, 'POST', { commit })).status, 200);
  const diff = await (await request(`${base}/commit-diff`, 'POST', { commit, path: 'tracked.txt' })).json(); assert.equal(diff.modified.text, 'initial\n');
  assert.equal((await request(`${base}/read`, 'POST', { path: '../outside' })).status, 400);
  assert.equal((await request(`${base}/read`, 'POST', { path: 'tracked.txt', taskId: randomUUID() })).status, 404);
});
test('terminal HTTP supports draft and task scope on every operation and rejects foreign query scope', async t => {
  const { request, writes } = await fixture(t);
  const base = '/v1/projects/sample/terminals';
  for (const taskId of [undefined, randomUUID()]) {
    const query = taskId ? `?taskId=${taskId}` : '';
    const body = { cols: 80, rows: 24, ...(taskId ? { taskId } : {}) };
    const opened = await request(base, 'POST', body); assert.equal(opened.status, 200);
    const session = await opened.json();
    const path = `${base}/${session.id}`;
    const output = await request(`${path}?after=0${taskId ? `&taskId=${taskId}` : ''}`); assert.equal(output.status, 200);
    assert.equal((await output.json()).chunks[0].data, 'ready\r\n');
    assert.equal((await request(`${path}/input${query}`, 'POST', { data: 'echo ok\r' })).status, 200);
    assert.equal((await request(`${path}/resize${query}`, 'POST', { cols: 100, rows: 30 })).status, 200);
    assert.equal((await request(`${path}?taskId=${randomUUID()}`)).status, 404);
    assert.equal((await request(`${path}/input?taskId=${randomUUID()}`, 'POST', { data: 'bad' })).status, 404);
    assert.equal((await request(`${path}/resize?taskId=${randomUUID()}`, 'POST', { cols: 100, rows: 30 })).status, 404);
    assert.equal((await request(`${path}?taskId=${randomUUID()}`, 'DELETE')).status, 404);
    assert.equal((await request(`${path}${query}`, 'DELETE')).status, 200);
  }
  assert.deepEqual(writes, ['echo ok\r', 'echo ok\r']);
});
