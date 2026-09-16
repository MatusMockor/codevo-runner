import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Task } from '../src/domain/contracts.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer artifact-test';
const exec = promisify(execFile);
async function fixture(t: TestContext, automatic = false) {
  const root = await mkdtemp(join(tmpdir(), 'codevo-artifact-http-'));
  const source = join(root, 'source');
  await mkdir(source);
  await exec('git', ['init', source]);
  await writeFile(join(source, 'base'), 'base');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const runnerId = randomUUID();
  const data = join(root, 'data');
  let app: Awaited<ReturnType<typeof createRunnerApplication>>;
  let url = '';
  async function start() {
    const services = await openRunnerServices(data, runnerId, { projects: [{ id: 'sample', name: 'Sample', path: source }],
      providers: (['codex', 'claude'] as const).map(provider => ({ provider, supportsAttachments: true,
        async execute(request) {
          await writeFile(join(request.cwd, 'design.html'), `<!doctype html><h1>${request.task.parentTaskId ? 'Second' : 'Design'}</h1><script>document.body.dataset.ready="yes"</script>`);
          await request.onOutput('stdout', automatic ? JSON.stringify(provider === 'codex'
            ? { type: 'item.completed', item: { type: 'agent_message', text: '[Design](design.html)' } }
            : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Design](design.html)' }] } }) + '\n' : '[Design](design.html)');
          return { exitCode: 0, sessionId: request.resumeSessionId ?? randomUUID() };
        } })) });
    app = await createRunnerApplication({ runnerId, name: 'Artifact', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }
  await start();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function launch(provider: 'codex' | 'claude') {
    const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider, parts: [{ type: 'text', text: 'Design' }] });
    const task = (await created.json()).task as Task;
    assert.equal((await post(`/v1/tasks/${task.id}/artifacts`, { path: 'design.html' })).status, 409);
    assert.equal((await post(`/v1/tasks/${task.id}/start`, { projectId: 'sample' })).status, 202);
    for (let count = 0; count < 250; count++) {
      const current = await (await get(`/v1/tasks/${task.id}`)).json() as Task;
      if (current.status === 'succeeded') return task;
      await delay(20);
    }
    assert.fail('Task did not finish');
  }
  return { root, data, get, post, launch, unauthenticated: (path: string) => fetch(`${url}${path}`), restart: async () => { await app.close(); await start(); } };
}

test('both providers expose immutable HTML snapshots over authenticated HTTP across restart', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = await f.launch('codex');
  const second = await f.launch('claude');
  for (const task of [first, second]) {
    const base = `/v1/tasks/${task.id}/artifacts`;
    const captured = await f.post(base, { path: join(f.data, 'workspaces', task.id, 'design.html') });
    assert.equal(captured.status, 201);
    const { artifact } = await captured.json();
    assert.equal(artifact.mediaType, 'text/html');
    await writeFile(join(f.data, 'workspaces', task.id, 'design.html'), 'changed');
    const again = await f.post(base, { path: 'design.html' });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).artifact.id, artifact.id);
    await f.restart();
    assert.deepEqual((await (await f.get(base)).json()).items, [artifact]);
    const content = await f.get(`${base}/${artifact.id}/content`);
    assert.equal(content.headers.get('content-type'), 'text/html');
    assert.match(content.headers.get('content-disposition')!, /^attachment;/);
    assert.match(await content.text(), /<h1>Design/);
    assert.equal((await f.unauthenticated(`${base}/${artifact.id}/content`)).status, 401);
    assert.equal((await f.get(`/v1/tasks/${task.id === first.id ? second.id : first.id}/artifacts/${artifact.id}/content`)).status, 404);
  }
});

test('artifacts reject escapes, links, corrupt or oversized content and decode supported images', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const task = await f.launch('claude');
  const cwd = join(f.data, 'workspaces', task.id);
  const base = `/v1/tasks/${task.id}/artifacts`;
  for (const path of ['../design.html', '/etc/test.html', 'file:///etc/test.html', '.git/config', 'x\\a.html'])
    assert.equal((await f.post(base, { path })).status, 400, path);
  await symlink(join(cwd, 'design.html'), join(cwd, 'linked.html'));
  await link(join(cwd, 'design.html'), join(cwd, 'hard.html'));
  for (const path of ['linked.html', 'hard.html']) assert.equal((await f.post(base, { path })).status, 409);
  await writeFile(join(cwd, 'bad.html'), Buffer.from([0xff]));
  assert.equal((await f.post(base, { path: 'bad.html' })).status, 415);
  await writeFile(join(cwd, 'big.html'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal((await f.post(base, { path: 'big.html' })).status, 413);
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).toFormat(format).toBuffer();
    await writeFile(join(cwd, `image.${format}`), bytes);
    const response = await f.post(base, { path: `image.${format}` });
    assert.equal(response.status, 201, await response.clone().text());
    const { artifact } = await response.json();
    assert.deepEqual(Buffer.from(await (await f.get(`${base}/${artifact.id}/content`)).arrayBuffer()), bytes);
  }
  await writeFile(join(cwd, 'fake.png'), '<html>bad</html>');
  assert.equal((await f.post(base, { path: 'fake.png' })).status, 415);
});

test('restart reconciles uncommitted blobs left between file sync and metadata commit', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const id = randomUUID();
  await writeFile(join(f.data, 'artifacts', id), 'orphan');
  await f.restart();
  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(join(f.data, 'artifacts', id)), { code: 'ENOENT' });
});

test('captured references replay after source worktree removal', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const task = await f.launch('codex');
  const path = join(f.data, 'workspaces', task.id, 'design.html');
  const base = `/v1/tasks/${task.id}/artifacts`;
  const response = await f.post(base, { path });
  const { artifact } = await response.json();
  await rm(join(f.data, 'workspaces', task.id), { recursive: true });
  await f.restart();
  for (const reference of ['design.html', path]) {
    const replay = await f.post(base, { path: reference });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).artifact.id, artifact.id);
  }
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} snapshots output before offline continuation overwrites shared workspace`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, true);
    const first = await f.launch(provider);
    // No artifact endpoint is called until both turns finish.
    const response = await f.post(`/v1/tasks/${first.id}/continue`, { idempotencyKey: randomUUID(), parts: [{ type: 'text', text: 'Revise design' }] });
    assert.equal(response.status, 202);
    const second = (await response.json()).task as Task;
    let finished = false;
    for (let count = 0; count < 250; count++) {
      if ((await (await f.get(`/v1/tasks/${second.id}`)).json()).status === 'succeeded') { finished = true; break; }
      await delay(20);
    }
    assert.equal(finished, true);
    await f.restart();
    for (const [task, label] of [[first, 'Design'], [second, 'Second']] as const) {
      const base = `/v1/tasks/${task.id}/artifacts`;
      const listing = await (await f.get(base)).json();
      assert.equal(listing.items.length, 1);
      const artifact = listing.items[0];
      assert.match(await (await f.get(`${base}/${artifact.id}/content`)).text(), new RegExp(`<h1>${label}</h1>`));
    }
  });
}
