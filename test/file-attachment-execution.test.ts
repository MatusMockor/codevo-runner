import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Task } from '../src/domain/contracts.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/index.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const authorization = 'Bearer file-execution-test-token';
const session = '01998cf0-2222-7222-8222-222222222222';
const inspect = `
  const fs = require('node:fs');
  const inspect = prompt => {
    const path = JSON.parse(/- path: (".*")/.exec(prompt)[1]);
    const stat = fs.statSync(path);
    return { path, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex'), mode: stat.mode & 0o7777,
      directory: fs.statSync(require('node:path').dirname(path)).mode & 0o7777, images: process.argv.includes('-i'), promptBytes: prompt.length };
  };`;
const providers = {
  codex: `${inspect}
  let prompt = '';
  process.stdin.on('data', chunk => prompt += chunk);
  process.stdin.on('end', () => {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: '${session}' }));
    console.log(JSON.stringify({ type: 'item.completed', observed: inspect(prompt) }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  });`,
  claude: `${inspect}
  const emit = frame => console.log(JSON.stringify(frame));
  let prompt = '';
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'control_request') emit({type:'control_response',response:{subtype:'success',request_id:'codevo-initialize'}});
    if (frame.type === 'user') {
      if (frame.message.content.length !== 1 || frame.message.content[0].type !== 'text') process.exit(8);
      prompt = frame.message.content[0].text;
      emit({type:'system',subtype:'init',session_id:'${session}'});
      emit({type:'control_request',request_id:'read-file',request:{subtype:'can_use_tool',tool_name:'Read',tool_use_id:'toolu_1',input:{file_path:JSON.parse(/- path: (".*")/.exec(prompt)[1])}}});
    }
    if (frame.type === 'control_response') {
      if (frame.response.response.behavior !== 'allow') process.exit(7);
      emit({type:'assistant',session_id:'${session}',observed:inspect(prompt)});
      emit({type:'result',subtype:'success',is_error:false,session_id:'${session}'});
      process.exit(0);
    }
  });`,
};

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} turn reads an uploaded file through its staged path, which is removed when the turn ends`, { timeout: 30_000 }, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'codevo-file-execution-')));
    const project = join(directory, 'project');
    const dataDir = join(directory, 'runner');
    const executable = join(directory, `fake-${provider}`);
    await mkdir(project);
    const git = promisify(execFile);
    await git('git', ['init', project]);
    await writeFile(join(project, 'README.md'), 'Project\n');
    await git('git', ['-C', project, 'add', 'README.md']);
    await git('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial project']);
    await writeFile(executable, `#!${process.execPath}\n${providers[provider]}`, { mode: 0o700 });
    const runnerId = randomUUID();
    const services = await openRunnerServices(dataDir, runnerId, {
      projects: [{ id: 'sample', name: 'Sample project', path: project }],
      providers: [new CliProviderExecutor(provider, { executable, timeoutMs: 20_000 })],
    });
    const app = await createRunnerApplication({ runnerId, name: 'File execution test', protocolVersion: 1,
      capabilities: { taskExecution: false, eventReplay: true } }, header => header === authorization, services);
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const get = (path: string) => fetch(`${url}${path}`, { headers: { authorization } });
    const post = (path: string, value: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(value) });

    const attachmentId = randomUUID();
    const bytes = randomBytes(9 * 1024 * 1024 + 11);
    const uploaded = await fetch(`${url}/v1/attachments/${attachmentId}`, { method: 'PUT', body: bytes,
      headers: { authorization, 'x-codevo-attachment-kind': 'file', 'content-type': 'application/zip', 'x-file-name': encodeURIComponent('..Dáta (1).zip') } });
    assert.equal(uploaded.status, 201);
    const created = await post('/v1/tasks', { idempotencyKey: randomUUID(), provider, parts: [{ type: 'text', text: 'Unpack the archive' }, { type: 'attachment', attachmentId }] });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: Task };
    assert.equal((await post(`/v1/tasks/${task.id}/start`, { projectId: 'sample' })).status, 202);
    let completed: Task | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      completed = await (await get(`/v1/tasks/${task.id}`)).json() as Task;
      if (completed.status === 'succeeded' || completed.status === 'failed') break;
      await delay(20);
    }
    const events = await (await get(`/v1/tasks/${task.id}/events`)).json() as { items: Array<{ type: string; channel?: string; text?: string }> };
    assert.equal(completed?.status, 'succeeded', JSON.stringify(events));
    const frames = events.items.filter(event => event.type === 'task.output' && event.channel === 'stdout').map(event => event.text ?? '').join('')
      .split('\n').filter(line => line.includes('"observed"')).map(line => JSON.parse(line) as { observed: Record<string, unknown> });
    assert.equal(frames.length, 1);
    const observed = frames[0]!.observed;
    assert.deepEqual(observed, { path: join(dataDir, 'execution-inputs', task.id, attachmentId, 'D_ta _1_.zip'),
      sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o600, directory: 0o700, images: false, promptBytes: observed.promptBytes });
    assert.ok(Number(observed.promptBytes) < 16 * 1024);
    await assert.rejects(stat(String(observed.path)), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(dataDir, 'execution-inputs')), []);
    const content = await get(`/v1/attachments/${attachmentId}/content`);
    assert.equal(content.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  });
}
