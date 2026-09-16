import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { openRunnerServices } from '../src/runtime.js';
import type { Task } from '../src/domain/contracts.js';

async function terminal(read: () => Promise<Task>) {
  for (let n = 0; n < 250; n++) {
    const value = await read();
    if (['succeeded', 'failed', 'cancelled'].includes(value.status)) return value;
    await setTimeout(20);
  }
  throw new Error('task timed out');
}

test('each resumed turn reconciles its immutable rules before provider start; conflicts block execution', {skip: process.platform !== 'linux'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'instruction-execution-'));
  const project = join(root, 'project');
  await mkdir(project);
  const git = promisify(execFile);
  await git('git', ['init', project]);
  await writeFile(join(project, 'CLAUDE.md'), 'original');
  await git('git', ['-C', project, 'add', '.']);
  await git('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial']);
  const observed: string[] = [];
  let workspace = '';
  const sessionId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), randomUUID(), {projects: [{id:'p',name:'Project',path:project}], providers: [{
    provider: 'codex', supportsAttachments: true,
    async execute(request) {
      workspace = request.cwd;
      observed.push(await readFile(join(request.cwd, 'CLAUDE.md'), 'utf8'));
      await request.onSession?.(sessionId);
      return {exitCode:0,sessionId};
    },
  }]});
  t.after(async () => {await services.close();await rm(root,{recursive:true,force:true});});
  const instructions = (content: string) => ({version:1,files:[{scope:'project',path:'CLAUDE.md',content}]});
  const first = (await services.tasks.create({idempotencyKey:randomUUID(),provider:'codex',parts:[{type:'text',text:'first'}],instructions:instructions('local first')})).task;
  await services.execution!.start(first.id,{projectId:'p'});
  assert.equal((await terminal(() => services.tasks.get(first.id))).status,'succeeded');
  const second = (await services.execution!.continue(first.id,{idempotencyKey:randomUUID(),parts:[{type:'text',text:'next'}],instructions:instructions('local second')})).task;
  assert.equal((await terminal(() => services.tasks.get(second.id))).status,'succeeded');
  assert.deepEqual(observed,['local first','local second']);
  assert.equal(await readFile(join(project,'CLAUDE.md'),'utf8'),'original');
  await writeFile(join(workspace,'CLAUDE.md'),'server edit');
  const third = (await services.execution!.continue(second.id,{idempotencyKey:randomUUID(),parts:[{type:'text',text:'next'}],instructions:instructions('local third')})).task;
  assert.equal((await terminal(() => services.tasks.get(third.id))).status,'failed');
  assert.deepEqual(observed,['local first','local second']);
  assert.ok((await services.tasks.events(third.id,0)).items.some(event => event.error === 'instruction_sync_failed'));
});
