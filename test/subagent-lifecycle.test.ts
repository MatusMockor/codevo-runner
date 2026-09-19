import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubagentLifecycleCollector, parseAgentSubagentLifecycle } from '../src/domain/subagent-lifecycle.js';
const line = (value: unknown) => JSON.stringify(value) + '\n';
test('Claude root tool and task aliases retain metrics and completion after chatter', () => {
  const c = new SubagentLifecycleCollector('claude');
  const started = line({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Agent',input:{description:'Explore'}}]}});
  assert.equal(c.feed(started.slice(0,20)),undefined);
  c.feed(started.slice(20));
  c.feed(line({type:'system',subtype:'task_started',task_id:'task-1',tool_use_id:'tool-1',task_type:'local_agent'}));
  c.feed(line({type:'system',subtype:'task_progress',task_id:'task-1',usage:{total_tokens:100,duration_ms:20,tool_uses:2},last_tool_name:'Read'}));
  c.feed(line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'done'}]}}));
  assert.equal(c.current()?.entries[0]?.state,'running');
  c.feed(line({type:'system',subtype:'task_notification',task_id:'task-1',status:'completed'}));
  for(let i=0;i<1000;i++) c.feed(line({type:'assistant',message:{content:[{type:'text',text:'chatter'}]}}));
  const snapshot = c.current()!;
  assert.equal(snapshot.entries.length,1);
  assert.deepEqual(snapshot.entries[0],{id:'tool:tool-1',toolId:'tool-1',taskId:'task-1',name:'Agent',description:'Explore',state:'completed',telemetryState:'completed',resultState:'completed',totalTokens:100,durationMs:20,steps:2,lastToolName:'Read',taskTitle:'Explore',batchKey:'spawn:tool-1'});
  assert.deepEqual(parseAgentSubagentLifecycle(snapshot),snapshot);
  assert.equal(c.feed(line({type:'system',subtype:'task_notification',task_id:'task-1',status:'completed'})),undefined);
});
test('child tools and shell background telemetry do not count as subagents',()=>{
 const c=new SubagentLifecycleCollector('claude');
 // A nested spawn with no retained ancestor is reported as lost, never promoted to the top level.
 c.feed(line({type:'assistant',parent_tool_use_id:'parent',message:{content:[{type:'tool_use',id:'nested',name:'Agent'}]}}));
 c.feed(line({type:'system',subtype:'task_started',task_type:'local_bash',task_id:'shell'}));
 assert.deepEqual(c.current(),{entries:[],truncated:true});
 c.feed(line({type:'assistant',parent_tool_use_id:'parent',message:{content:[{type:'tool_use',id:'child',name:'Bash'}]}}));
 assert.deepEqual(c.current(),{entries:[],truncated:true});
});
test('retains bounded terminal tombstones, overflow explicit and final partial frame handled',()=>{
 const c=new SubagentLifecycleCollector('claude');
 for(let i=0;i<33;i++) c.feed(line({type:'system',subtype:'task_started',task_id:`task${i}`}));
 assert.equal(c.current()?.entries.length,32); assert.equal(c.current()?.truncated,true);
 c.feed(JSON.stringify({type:'system',subtype:'task_notification',task_id:'task0',status:'completed'}));
 assert.equal(c.finish()?.entries[0]?.state,'completed');
 c.feed(line({type:'system',subtype:'task_progress',task_id:'task0'}));
 assert.equal(c.current()?.entries[0]?.state,'completed');
 assert.deepEqual(parseAgentSubagentLifecycle(c.current()),c.current());
});
test('oversized JSON line discarded through newline, later lifecycle is retained',()=>{
 const c=new SubagentLifecycleCollector('claude');
 c.feed('x'.repeat(1024*1024)); c.feed('x');
 assert.equal(c.current()?.truncated,true);
 c.feed('ignored\n'+line({type:'system',subtype:'task_started',task_id:'recovered'}));
 assert.equal(c.current()?.entries[0]?.taskId,'recovered');
 assert.equal(c.finish(),undefined);
});
test('Codex native normalized interruption remains interrupted and resumed child runs again',()=>{
 const c=new SubagentLifecycleCollector('codex');
 const frame=(kind:string)=>line({v:1,t:'subagent',agentThreadId:'child',agentPath:'/root/helper',kind});
 c.feed(frame('started')); c.feed(frame('interrupted'));
 assert.equal(c.current()?.entries[0]?.state,'interrupted');
 assert.deepEqual(parseAgentSubagentLifecycle(c.current()),c.current());
 c.feed(frame('started')); assert.equal(c.current()?.entries[0]?.state,'interrupted');
 c.feed(frame('interacted')); assert.equal(c.current()?.entries[0]?.state,'running');
 c.feed(line({v:1,t:'subagentTurnCompleted',agentThreadId:'child',durationMs:500,isError:false}));
 assert.equal(c.current()?.entries[0]?.state,'completed');
});
test('Codex collab items reuse child identity and malformed metrics cannot poison persistence',()=>{
 const c=new SubagentLifecycleCollector('codex');
 c.feed(line({type:'item.started',item:{type:'collab_agent_tool_call',receiverThreadIds:['child'],tool:'spawn_agent'}}));
 c.feed(line({type:'item.completed',item:{type:'collab_agent_tool_call',receiverThreadIds:['child'],agentsStates:{child:{status:'errored'}}}}));
 assert.equal(c.current()?.entries.length,1);assert.equal(c.current()?.entries[0]?.state,'failed');
 assert.throws(()=>parseAgentSubagentLifecycle({entries:[{...c.current()!.entries[0],durationMs:-1}],truncated:false}));
 assert.throws(()=>parseAgentSubagentLifecycle({...c.current(),unknown:true}));
});
test('shell task completion without task_type cannot invent an agent, even after exclusions overflow',()=>{
 const c=new SubagentLifecycleCollector('claude');
 for(let i=0;i<514;i++) c.feed(line({type:'system',subtype:'task_started',task_type:'local_bash',task_id:`shell${i}`}));
 for(const i of [0,512,513]) c.feed(line({type:'system',subtype:'task_notification',task_id:`shell${i}`,status:'completed'}));
 assert.deepEqual(c.current(),{entries:[],truncated:true});
 c.feed(line({type:'system',subtype:'task_started',task_type:'local_agent',task_id:'real'}));
 c.feed(line({type:'system',subtype:'task_notification',task_id:'real',status:'completed'}));
 assert.equal(c.current()?.entries.length,1);assert.equal(c.current()?.entries[0]?.state,'completed');
});
test('Claude killed, cancelled and interrupted tasks settle and delayed progress cannot resurrect them',()=>{
 for(const status of ['killed','cancelled','canceled','interrupted']) {
  const c=new SubagentLifecycleCollector('claude');
  c.feed(line({type:'system',subtype:'task_started',task_type:'local_agent',task_id:'real'}));
  c.feed(line({type:'system',subtype:'task_notification',task_id:'real',status}));
  c.feed(line({type:'system',subtype:'task_progress',task_id:'real'}));
  assert.equal(c.current()?.entries[0]?.state,'interrupted');
  assert.deepEqual(parseAgentSubagentLifecycle(c.current()),c.current());
 }
});
test('Codex sendInput resumes a completed child using official camel-case tool name',()=>{
 const c=new SubagentLifecycleCollector('codex');
 c.feed(line({v:1,t:'subagentTurnCompleted',agentThreadId:'child',durationMs:null,isError:false}));
 c.feed(line({type:'item.started',item:{type:'collab_agent_tool_call',receiverThreadIds:['child'],tool:'sendInput'}}));
 assert.equal(c.current()?.entries[0]?.state,'running');
});
