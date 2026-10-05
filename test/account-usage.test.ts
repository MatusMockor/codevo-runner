import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { AccountUsageService } from '../src/application/account-usage-service.js';
import { parseCodexUsage, validateAccountUsage } from '../src/domain/account-usage.js';
import { CliAccountUsageReader } from '../src/infrastructure/execution/account-usage.js';
import { claudeUsageIdentity, codexUsageIdentity } from '../src/infrastructure/execution/account-usage-identity.js';
import { openRunnerServices } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

const auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: ' User@Example.com ', orgId: ' org-1 ' };
const account = { account: { type: 'chatgpt', email: ' User@Example.com ' }, workspaceRouting: { chatgptAccountId: ' account-1 ' } };
const limits = { accountId: 'account-1', rateLimitsByLimitId: { codex: { limitName: null,
  primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1788771347 },
  secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1788983872 } } } };
const claudeUsage = { result: 'Current session: 6% used · resets tomorrow at 10:40pm\nCurrent week (all models): 93% used · resets tomorrow at 8am' };

async function fixture(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name + '.cjs');
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o700);
  return path;
}
function codexFixture(root: string, after: unknown = account, usage: unknown = limits): Promise<string> {
  return fixture(root, 'codex', `
const fs = require('node:fs'); const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(join(root, 'launches'))}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)})+'\\n');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server','--stdio'])) process.exit(2);
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line); if (request.method === 'initialized') return;
 const result = request.id === 0 ? {} : request.id === 2 ? ${JSON.stringify(account)} : request.id === 1 ? ${JSON.stringify(usage)} : ${JSON.stringify(after)};
 fs.appendFileSync(${JSON.stringify(join(root, 'requests'))}, request.id+'\\n');
 setTimeout(() => process.stdout.write(JSON.stringify({id:request.id,result})+'\\n'), 70);
});
setInterval(()=>{},1000);`);
}

test('real CLI usage API negotiates capability, pins runner authority, coalesces reads and returns no private fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-account-usage-'));
  const codexExecutable = await codexFixture(root);
  const claudeExecutable = await fixture(root, 'claude', `
const args=process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(['auth','status','--json'])) { console.log(${JSON.stringify(JSON.stringify(auth))}); process.exit(0); }
if (JSON.stringify(args) !== JSON.stringify(['--safe-mode','--tools','','-p','/usage','--output-format','json','--permission-mode','dontAsk','--no-session-persistence'])) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(claudeUsage))});`);
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId,
    { projects: [], projectsRoot: join(root, 'projects'), providers: [], accountUsageCli: { codexExecutable, claudeExecutable } });
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Usage', capabilities: { taskExecution: false, eventReplay: true } }, header => header === 'Bearer test', services);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  const legacy = await (await fetch(base + '/v1/runner', { headers })).json();
  assert.equal('accountUsage' in legacy.capabilities, false);
  const modern = await (await fetch(base + '/v1/runner', { headers: { ...headers, 'x-codevo-client-capabilities': 'accountUsage' } })).json();
  assert.equal(modern.capabilities.accountUsage, true);
  for (const provider of ['claude', 'codex']) {
    const url = `${base}/v1/account-usage/${provider}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer test' } })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, 'x-codevo-runner-id': randomUUID() } })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(url + '?workspace=/tmp', { headers })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 405);
    const bodyStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { method: 'GET', headers: { ...headers, 'content-length': '2' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject); request.end('{}');
    });
    assert.equal(bodyStatus, 400);
  }
  assert.equal((await fetch(base + '/v1/account-usage/other', { headers })).status, 404);
  const replies = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await fetch(base + '/v1/account-usage/codex', { headers });
    assert.equal(response.status, 200);
    return validateAccountUsage(await response.json());
  }));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  const snapshot = replies[0]!;
  assert.equal(snapshot.provider, 'codex');
  assert.equal(snapshot.windows[0]?.usedPercent, 11);
  assert.equal(snapshot.windows[1]?.label, 'Codex · Weekly limit');
  assert.equal(snapshot.accountIdentity, codexUsageIdentity(account, limits, account));
  assert.deepEqual((await readFile(join(root, 'requests'), 'utf8')).trim().split('\n'), ['0', '2', '1', '3']);
  const launch = JSON.parse((await readFile(join(root, 'launches'), 'utf8')).trim());
  assert.equal(launch.cwd, homedir());
  assert.deepEqual(launch.args, ['app-server', '--stdio']);
  const claude = validateAccountUsage(await (await fetch(base + '/v1/account-usage/claude', { headers })).json());
  assert.equal(claude.windows[1]?.usedPercent, 93);
  assert.equal(claude.accountIdentity, claudeUsageIdentity(auth));
  assert.equal(JSON.stringify(claude).includes('Example'), false);
});

test('outbound usage rejects oversize Unicode, controls, duplicate windows and explicit undefined nullable fields', () => {
  const window = { id: 'five_hour', label: '5-hour limit', usedPercent: 10, windowDurationMinutes: 300, resetsAtEpochMs: null, resetsLabel: null };
  const snapshot = { provider: 'claudeCode', fetchedAtEpochMs: 1, windows: [window], accountIdentity: null };
  for (const changed of [{ ...window, label: 'é'.repeat(81) }, { ...window, resetsLabel: 'reset\u0085today' }, { ...window, resetsAtEpochMs: undefined }, { ...window, usedPercent: Infinity }, { ...window, usedPercent: 101 }]) assert.throws(() => validateAccountUsage({ ...snapshot, windows: [changed] }));
  assert.throws(() => validateAccountUsage({ ...snapshot, windows: [window, window] }));
  assert.throws(() => validateAccountUsage({ ...snapshot, extra: 'unknown' }));
  assert.deepEqual(parseCodexUsage({ rateLimitsByLimitId: null, rateLimits: limits.rateLimitsByLimitId.codex }), parseCodexUsage(limits));
});

test('usage identities require complete unchanged account authorities and shared hash encoding', () => {
  const hash = createHash('sha256').update(JSON.stringify(['codevo-account-usage-v1', 'claudeCode', 'claude-oauth', 'user@example.com', 'org-1'])).digest('hex');
  assert.equal(claudeUsageIdentity(auth), 'account:v1:sha256:' + hash);
  assert.equal(claudeUsageIdentity(auth), 'account:v1:sha256:9f14f610c68aac6373e7778b7bcf584800d6cbacc4a61d415e996ae6a51477da');
  assert.equal(codexUsageIdentity(account, limits, account), 'account:v1:sha256:a7f409c1e47115f8a94e3a73d4b32301a53531a2be7ac4e7e712ad25fd65525a');
  for (const changed of [{ ...auth, loggedIn: false }, { ...auth, authMethod: 'apiKey' }, { ...auth, orgId: '' }, { ...auth, email: 'ü@example.com' }, { ...auth, email: 'not-email' }, { ...auth, email: 'a b@example.com' }, { ...auth, orgId: 'x'.repeat(257) }]) assert.equal(claudeUsageIdentity(changed), null);
  for (const changed of [{ account: { type: 'apiKey' } }, { account: { type: 'chatgpt', email: 'other@example.com' } }, { ...account, workspaceRouting: { chatgptAccountId: 'other' } }, { ...account, workspaceRouting: 3 }, { ...account, workspaceRouting: {} }, { ...account, workspaceRouting: { unknown: true } }]) assert.equal(codexUsageIdentity(account, limits, changed), null);
  assert.equal(codexUsageIdentity(account, { ...limits, accountId: undefined }, account), null);
});

test('duplicate and foreign CLI replies fail closed without leaking provider output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-account-replies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of [0, 99]) {
    const executable = await fixture(root, 'reply-' + id, `
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===0) process.stdout.write(JSON.stringify({id:0,result:{}})+'\\n'+JSON.stringify({id:${id},result:{private:'secret'}})+'\\n');
}); setInterval(()=>{},1000);`);
    const service = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: executable }));
    t.after(() => service.close());
    await assert.rejects(service.read('codex'), { message: 'storage_unavailable' });
  }
  const malformed = await fixture(root, 'contradictory', `
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===0) process.stdout.write(JSON.stringify({id:0,result:{},error:{message:'secret'}})+'\\n');
}); setInterval(()=>{},1000);`);
  const invalid = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: malformed }));
  t.after(() => invalid.close());
  await assert.rejects(invalid.read('codex'), { message: 'storage_unavailable' });
});

test('real Codex account switch retains usage with unknown identity and bounded output errors remain generic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-account-switch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await codexFixture(root, { account: { type: 'chatgpt', email: 'other@example.com' } });
  const service = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: executable }));
  t.after(() => service.close());
  const snapshot = await service.read('codex');
  assert.equal(snapshot.accountIdentity, null);
  assert.equal(snapshot.windows.length, 2);
  const oversized = await fixture(root, 'oversized', `process.stdout.write('secret'.repeat(12000)); setInterval(()=>{},1000);`);
  const bounded = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: oversized }));
  t.after(() => bounded.close());
  await assert.rejects(bounded.read('codex'), { message: 'storage_unavailable' });
  const malformed = await fixture(root, 'invalid', `process.stdout.write(Buffer.from([0xff,0x0a])); setInterval(()=>{},1000);`);
  const invalid = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: malformed }));
  t.after(() => invalid.close());
  await assert.rejects(invalid.read('codex'), { message: 'storage_unavailable' });
});

test('timeout and service shutdown reap real provider process groups without late publishing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-account-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'pid');
  const descendantPath = join(root, 'descendant-pid');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(descendantPath)},String(process.pid)); setInterval(()=>{},1000);`;
  const executable = await fixture(root, 'hanging', `
require('node:fs').writeFileSync(${JSON.stringify(path)},String(process.pid));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});
setInterval(()=>{},1000);`);
  const readPid = async (file: string): Promise<number> => {
    const until = Date.now() + 8_000;
    for (;;) {
      try { return Number(await readFile(file, 'utf8')); }
      catch (error) { if (Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
  };
  const assertReaped = async (pid: number) => {
    const until = Date.now() + 2_000;
    for (;;) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return; }
      if (Date.now() >= until) assert.fail(`Provider descendant ${pid} survived cleanup`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const service = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: executable, timeoutMs: 5_000 }));
  await assert.rejects(service.read('codex'), { message: 'storage_unavailable' });
  await assertReaped(await readPid(path));
  await assertReaped(await readPid(descendantPath));
  await rm(path); await rm(descendantPath);
  const closing = new AccountUsageService(new CliAccountUsageReader({ codexExecutable: executable }));
  const pending = closing.read('codex');
  const rejected = assert.rejects(pending, { message: 'storage_unavailable' });
  const active = await readPid(path), child = await readPid(descendantPath);
  await closing.close();
  await rejected;
  await assertReaped(active); await assertReaped(child);
  await assert.rejects(closing.read('codex'), { message: 'storage_unavailable' });
});
