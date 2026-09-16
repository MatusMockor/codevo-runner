import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryDatabase } from '../src/infrastructure/sqlite/database.js';
import { CliProviderExecutor } from '../src/infrastructure/execution/cli-executor.js';
import { ProviderArtifactReferences } from '../src/domain/artifact-output.js';

const input = (provider: 'codex' | 'claude' = 'codex') => ({ idempotencyKey: randomUUID(), provider, parts: [{ type: 'text' as const, text: 'long task' }] });

test('rolling retention persists gap boundary separately from stderr and preserves lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-output-window-'));
  const runnerId = randomUUID();
  let db = new RepositoryDatabase(directory, runnerId);
  try {
    const task = db.createTask(input()).task;
    db.queueTask(task.id, 'project'); db.claimNextTask();
    db.appendTaskOutput(task.id, 'stdout', 'partial');
    db.appendTaskOutput(task.id, 'stderr', 'warning\n');
    for (let i = 0; i < 1023; i++) db.appendTaskOutput(task.id, 'stdout', '{}\n');
    let page = db.listEvents(task.id, 0);
    const watermark = page.outputTruncatedBeforeSequence!;
    assert.ok(watermark > 0); assert.equal(page.outputStartsAtLineBoundary, false);
    db.appendTaskOutput(task.id, 'stdout', '{}\n');
    page = db.listEvents(task.id, 0);
    assert.ok(page.outputTruncatedBeforeSequence! > watermark);
    assert.equal(page.outputStartsAtLineBoundary, false, 'stderr eviction cannot reset stdout boundary');
    db.close(); db = new RepositoryDatabase(directory, runnerId);
    assert.equal(db.listEvents(task.id, 0).outputStartsAtLineBoundary, false);
    db.appendTaskOutput(task.id, 'stdout', '{"final":"latest"}\n');
    db.finishTask(task.id, { exitCode: 0 });
    assert.equal(db.listEvents(task.id, 0).outputStartsAtLineBoundary, true);
    const types: string[] = []; let after = 0; let lastOutput = '';
    for (;;) {
      const next = db.listEvents(task.id, after);
      for (const e of next.items) { types.push(e.type); if (e.text) lastOutput = e.text; }
      if (next.nextCursor === null) break; after = next.nextCursor;
    }
    assert.deepEqual(types.slice(0, 3), ['task.created', 'task.queued', 'task.running']);
    assert.equal(types.at(-1), 'task.succeeded'); assert.equal(lastOutput, '{"final":"latest"}\n');
    assert.equal(db.searchHistory({ q: 'missing', after: 0 }).incomplete, true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema6 migration preserves task and establishes empty retention metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-output-migration-'));
  const runnerId = randomUUID(); let db = new RepositoryDatabase(directory, runnerId);
  try {
    const task = db.createTask(input()).task; db.close();
    const old = new DatabaseSync(join(directory, 'runner.sqlite'));
    old.exec('ALTER TABLE task_execution DROP COLUMN output_truncated_before_sequence; ALTER TABLE task_execution DROP COLUMN output_starts_at_line_boundary; PRAGMA user_version=6'); old.close();
    db = new RepositoryDatabase(directory, runnerId);
    assert.deepEqual(db.getTask(task.id), task);
    assert.equal(db.listEvents(task.id, 0).outputTruncatedBeforeSequence, undefined);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const provider of ['codex', 'claude'] as const) test(`${provider} process emits >1MiB with backpressure, durable newest output and late artifacts`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-long-process-'));
  const db = new RepositoryDatabase(directory, randomUUID());
  try {
    const task = db.createTask(input(provider)).task; db.queueTask(task.id, 'project'); db.claimNextTask();
    const session = randomUUID();
    const frames = provider === 'codex' ? [
      { type: 'thread.started', thread_id: session },
      { type: 'item.completed', item: { type: 'agent_message', text: '[preview](design.html)' } },
      { type: 'turn.completed' },
    ] : [
      { type: 'system', subtype: 'init', session_id: session },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[preview](design.html)' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: session },
    ];
    const executable = join(directory, 'fake-provider');
    const script = join(directory, 'provider.cjs');
    await writeFile(script, `const {once}=require('node:events');\n(async()=>{const frames=${JSON.stringify(frames)};const write=async x=>{if(!process.stdout.write(JSON.stringify(x)+'\\n'))await once(process.stdout,'drain')};await write(frames[0]);for(let i=0;i<400;i++)await write({type:'diagnostic',text:'x'.repeat(8192)});await write(frames[1]);await write(frames[2]);})();`, { mode: 0o700 });
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
    const references = new ProviderArtifactReferences(provider); let total = 0;
    const result = await new CliProviderExecutor(provider, { executable, timeoutMs: 10_000 }).execute({
      task, cwd: directory, attachments: [], signal: new AbortController().signal,
      onSession: async id => db.setTaskSession(task.id, id),
      onOutput: async (channel, text) => { total += Buffer.byteLength(text); if (channel === 'stdout') references.push(text); db.appendTaskOutput(task.id, channel, text); },
    });
    assert.ok(total > 3 * 1024 * 1024); assert.equal(result.error, undefined); assert.equal(result.sessionId, session);
    assert.deepEqual(references.finish(), ['design.html']); assert.equal(references.isComplete(), true);
    assert.equal(db.finishTask(task.id, result).status, 'succeeded');
    assert.ok(db.listEvents(task.id, 0).outputTruncatedBeforeSequence);
    let after = 0; let output = '';
    for (;;) { const page = db.listEvents(task.id, after); output += page.items.map(e => e.text ?? '').join(''); if (page.nextCursor === null) break; after = page.nextCursor; }
    assert.ok(Buffer.byteLength(output) <= 1024 * 1024); assert.ok(output.includes('design.html'));
    assert.equal(db.getResumeState(task.id).available, true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
