import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaintenanceClock } from '../src/application/maintenance-lease.js';

type Timer = { at: number; action: () => void };

export class ManualClock implements MaintenanceClock {
  private time = 0;
  private readonly timers = new Set<Timer>();
  now(): number { return this.time; }
  schedule(delayMs: number, action: () => void): () => void {
    const timer = { at: this.time + delayMs, action };
    this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }
  get scheduled(): number { return this.timers.size; }
  skip(ms: number): void { this.time += ms; }
  advance(ms: number): void {
    this.time += ms;
    for (const timer of [...this.timers].sort((left, right) => left.at - right.at)) {
      if (timer.at > this.time || !this.timers.delete(timer)) continue;
      timer.action();
    }
  }
}

export function assertUpdaterLease(body: string, leaseId: string, runnerId: string): number {
  const value: unknown = JSON.parse(body);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), body);
  const lease = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(lease).sort(), ['expiresInMs', 'leaseId', 'runnerId']);
  assert.equal(lease.leaseId, leaseId);
  assert.equal(lease.runnerId, runnerId);
  assert.match(body, /"expiresInMs":[0-9]+[,}]/);
  const expiresInMs = lease.expiresInMs;
  assert.ok(typeof expiresInMs === 'number' && Number.isInteger(expiresInMs), body);
  assert.ok(5000 < expiresInMs && expiresInMs <= 60000, body);
  return expiresInMs;
}

export function schemaShape(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!['user_version']);
    const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
      .map(row => [row['type'], row['name'], row['tbl_name'], row['sql']]);
    return { version, rows };
  } finally { db.close(); }
}

export function updaterSnapshot(dataDir: string) {
  const path = join(dataDir, 'runner.sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const counts = (sql: string) => Object.fromEntries(db.prepare(sql).all().map(row => [String(row['status']), Number(row['total'])]));
    const count = (sql: string) => Number(db.prepare(sql).get()!['total']);
    const shape = schemaShape(path);
    return {
      identity: db.prepare("SELECT value FROM metadata WHERE key='runnerId'").get()!['value'],
      schema: shape.version, schemaShape: shape.rows,
      tasks: counts("SELECT json_extract(payload,'$.status') AS status,count(*) AS total FROM tasks GROUP BY 1"),
      clones: counts('SELECT status,count(*) AS total FROM project_clones GROUP BY 1'),
      pending: count("SELECT count(*) AS total FROM pending_messages WHERE json_extract(payload,'$.status')='queued'"),
      attachments: count('SELECT count(*) AS total FROM attachments'),
      managedProjects: count('SELECT count(*) AS total FROM managed_projects'),
    };
  } finally { db.close(); }
}

export function updaterIdle(snapshot: ReturnType<typeof updaterSnapshot>): boolean {
  return !snapshot.tasks['running'] && !snapshot.tasks['queued'] && !snapshot.clones['running'] && !snapshot.clones['queued'] && snapshot.pending === 0;
}

export async function eventually<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await delay(10);
    value = await read();
  }
  assert.ok(ready(value), `${label} did not settle`);
  return value;
}

const usageAuth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'user@example.com', orgId: 'org-1' };
const usageReport = { result: 'Current session: 6% used · resets tomorrow at 10:40pm\nCurrent week (all models): 93% used · resets tomorrow at 8am' };

export async function usageProbeStub(directory: string, gated: boolean) {
  const executable = join(directory, 'claude-usage.cjs');
  const launches = join(directory, 'usage-launches');
  const release = join(directory, 'usage-release');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(' ') + '\\n');
const step = fs.readFileSync(${JSON.stringify(launches)}, 'utf8').split('\\n').filter(Boolean).length;
const answer = () => {
  if (${JSON.stringify(gated)} && !fs.existsSync(${JSON.stringify(release)} + '-' + step)) return;
  clearInterval(timer);
  console.log(process.argv[2] === 'auth' ? ${JSON.stringify(JSON.stringify(usageAuth))} : ${JSON.stringify(JSON.stringify(usageReport))});
  process.exit(0);
};
const timer = setInterval(answer, 20);
answer();
`, { mode: 0o700 });
  return {
    executable,
    launched: async () => (await readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
    release: (step: number) => writeFile(`${release}-${step}`, ''),
  };
}
