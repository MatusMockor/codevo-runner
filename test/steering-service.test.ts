import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { SteeringService } from '../src/application/steering-service.js';
import type { ProviderSteerInput } from '../src/domain/steering.js';

async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'runner-steering-service-'));
 const repository = await openSqliteRepository(directory, randomUUID());
 t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
 const task = (await repository.createTask({ idempotencyKey: randomUUID(), provider: 'codex', parts: [{type:'text', text:'initial'}] })).task;
 await repository.queueTask(task.id, 'project'); await repository.claimNextTask();
 const service = new SteeringService(repository);
 const abort = new AbortController(); const session = service.open(task.id, abort.signal);
 return { repository, task, service, abort, session };
}
const input = () => ({idempotencyKey:randomUUID(), parts:[{type:'text' as const,text:'follow up'}]});

test('acknowledged steering is replayable after owner closes and creates one durable input', async t => {
 const { repository,task,service,session } = await fixture(t);
 const delivered: ProviderSteerInput[] = [];
 session.ready(async value => { delivered.push(value); });
 const message = input();
 const receipt = await service.steer(task.id, message);
 await session.close();
 assert.deepEqual(await service.steer(task.id,message),receipt);
 assert.equal(delivered.length,1);
 const events = (await repository.listEvents(task.id,0)).items.filter(event => event.type === 'task.input');
 assert.equal(events.length,1); assert.deepEqual(events[0]!.parts,message.parts);
});

test('uncertain writes never retry and do not claim successful receipt', async t => {
 const {task,service,session} = await fixture(t);
 let writes=0;
 session.ready(async () => {writes++;throw new Error('lost acknowledgement');});
 const message=input();
 await assert.rejects(service.steer(task.id,message),{code:'delivery_uncertain'});
 await assert.rejects(service.steer(task.id,message),{code:'delivery_uncertain'});
 assert.equal(writes,1); await session.close();
});

test('completed tool boundary drains one compatible queued message without waiting for terminal task', async t => {
 const {repository,task,service,session}=await fixture(t);
 const pending=await repository.enqueuePending(task.id,input());
 let writes=0;session.ready(async()=>{writes++;});
 await session.boundary();
 assert.equal(writes,1);assert.equal((await repository.getTask(task.id)).status,'running');
 assert.deepEqual((await repository.listPending(task.id)).items,[]);
 assert.equal((await service.pending(task.id,pending.pending.id)).messageId,pending.pending.id);
 await session.close();
});

test('Stop and replacement owner reject stale input; concurrent admission is bounded', async t => {
 const {task,service,session,abort}=await fixture(t);
 let release!:()=>void;let entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 session.ready(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const first=service.steer(task.id,input());await ready;
 await assert.rejects(service.steer(task.id,input()),{code:'busy'});
 abort.abort();
 await assert.rejects(service.steer(task.id,input()),{code:'conflict'});
 release();await first;await session.close();
});

test('definitively rejected image steering releases staging and quota for retry', async t => {
 const {repository,task} = await fixture(t);
 const {SteeringNotSent}=await import('../src/domain/steering.js');
 const image=randomUUID();
 await repository.putAttachment({id:image,runnerId:task.runnerId,name:'image.png',mediaType:'image/png',bytes:1,sha256:'a'.repeat(64),width:1,height:1,createdAt:new Date().toISOString()});
 let cleaned=0;let staged=0;
 const service=new SteeringService(repository,{stage:async(_id,ids)=>{staged++;return {attachments:ids.map(id=>({id,path:'/test/image.png',mediaType:'image/png' as const})),cleanup:async()=>{cleaned++;}};}});
 const session=service.open(task.id,new AbortController().signal);
 let calls=0;session.ready(async()=>{if(calls++<9)throw new SteeringNotSent('question_pending');});
 const message={idempotencyKey:randomUUID(),parts:[{type:'attachment' as const,attachmentId:image}]};
 for(let index=0;index<9;index++) await assert.rejects(service.steer(task.id,message),{code:'conflict'});
 assert.equal(cleaned,9);
 await service.steer(task.id,message);
 assert.equal(staged,10);
 await session.close();assert.equal(cleaned,10);
});
