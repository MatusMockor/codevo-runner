import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CommandCatalogWorkdir } from '../src/application/command-catalog-service.js';
import { validateCommandCatalog } from '../src/domain/command-catalog.js';
import { CliCommandCatalogReader } from '../src/infrastructure/execution/command-catalog.js';

const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--no-session-persistence'];
const open = () => new AbortController().signal;
const FAST = { pollMs: 10, settleMs: 250, capMs: 5_000 };
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

async function workspace(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-command-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const info = await lstat(cwd);
  const workdir: CommandCatalogWorkdir = { cwd, identity: { dev: info.dev, ino: info.ino } };
  const fixture = async (name: string, source: string): Promise<string> => {
    const path = join(root, name + '.cjs');
    await writeFile(path, `#!${process.execPath}\n${source}`);
    await chmod(path, 0o700);
    return path;
  };
  return { root, workdir, fixture };
}
function claudeSource(root: string, commands: string, before = ''): string {
  return `
const fs = require('node:fs'); let input = '';
process.stdin.setEncoding('utf8').on('data', chunk => { input += chunk; }).on('end', () => {
  const request = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(join(root, 'launches'))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), stdinEnded: true,
    lines: input.split('\\n').length - 1, type: request.type, subtype: request.request.subtype, keys: Object.keys(process.env).sort(),
    mcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS, ide: process.env.CLAUDE_CODE_AUTO_CONNECT_IDE, install: process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL }) + '\\n');
  ${before}
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
    response: { commands: ${commands}, account: { email: 'person@example.invalid' } } } }) + '\\n');
});`;
}
function codexSource(root: string, skills: string, before = ''): string {
  return `
const fs = require('node:fs'); const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(join(root, 'launches'))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), keys: Object.keys(process.env).sort() }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let polls = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(join(root, 'requests'))}, JSON.stringify(request) + '\\n');
  if (request.method === 'initialized') return;
  if (request.id === 0) return send({ id: 0, result: { userAgent: 'synthetic' } });
  polls++;
  ${before}
  send({ method: 'skills/changed', params: {} });
  send({ id: request.id, method: 'server/request', params: {} });
  send({ id: request.id - 1, result: { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'stale' }], errors: [] }] } });
  send({ id: request.id + 100, error: { message: 'unrelated' } });
  send({ result: { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'anonymous' }], errors: [] }] } });
  send({ id: request.id, result: { data: [{ cwd: '/elsewhere', skills: [{ name: 'foreign' }], errors: [] },
    { cwd: request.params.cwds[0], skills: ${skills}, errors: [] }] } });
});
setInterval(() => {}, 1000);`;
}
function pollingSource(root: string, body: string): string {
  return `
const fs = require('node:fs'); const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let polls = 0, pending = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') return;
  if (request.id === 0) return send({ id: 0, result: {} });
  const poll = ++polls;
  pending++;
  const reply = (names, errors = []) => send({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], skills: names.map(name => ({ name })), errors }] } });
  setTimeout(() => {
    fs.appendFileSync(${JSON.stringify(join(root, 'polls'))}, JSON.stringify({ id: request.id, poll, pending, cwds: request.params.cwds }) + '\\n');
    pending--;
    ${body}
  }, 15);
});
setInterval(() => {}, 1000);`;
}
async function pollLog(root: string): Promise<Array<{ id: number; poll: number; pending: number; cwds: string[] }>> {
  const text = await readFile(join(root, 'polls'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function readPid(file: string): Promise<number> {
  const until = Date.now() + 8_000;
  for (;;) {
    try { return Number(await readFile(file, 'utf8')); }
    catch (error) { if (Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
async function assertReaped(pid: number) {
  const until = Date.now() + 2_000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    if (Date.now() >= until) assert.fail(`Provider descendant ${pid} survived cleanup`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function hangingSource(root: string): string {
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'descendant-pid'))},String(process.pid)); setInterval(()=>{},1000);`;
  return `
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'pid'))},String(process.pid));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});
setInterval(()=>{},1000);`;
}

test('Claude probe runs in the pinned project directory with the task environment and ends stdin', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const claudeExecutable = await fixture('claude', claudeSource(root, JSON.stringify([
    { name: 'pr', description: 'Open a\npull request.', argumentHint: '[title]', builtin: true, aliases: ['p'] },
    { name: '__internal' }, { name: 'bad name' }, { name: 'plain' }, { name: 'pr', description: 'Duplicate.' },
  ])));
  process.env.CODEVO_CATALOG_TEST_SECRET = 'must-not-reach-the-provider';
  t.after(() => { delete process.env.CODEVO_CATALOG_TEST_SECRET; });
  const catalog = await new CliCommandCatalogReader({ claudeExecutable }).read('claudeCode', workdir, open());
  assert.deepEqual(validateCommandCatalog(catalog), { version: 1, provider: 'claudeCode', truncated: false, entries: [
    { kind: 'command', name: 'pr', label: null, description: 'Open a pull request.', argumentHint: '[title]', builtin: true },
    { kind: 'command', name: 'plain', label: null, description: null, argumentHint: null, builtin: false },
  ] });
  assert.equal(JSON.stringify(catalog).includes('example.invalid'), false);
  const launches = (await readFile(join(root, 'launches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.equal(launch.cwd, workdir.cwd);
  assert.deepEqual(launch.args, CLAUDE_ARGS);
  assert.deepEqual([launch.stdinEnded, launch.lines, launch.type, launch.subtype], [true, 1, 'control_request', 'initialize']);
  assert.deepEqual([launch.mcp, launch.ide, launch.install], ['false', '0', '1']);
  assert.equal(launch.keys.includes('CODEVO_CATALOG_TEST_SECRET'), false);
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_AUTO_CONNECT_IDE', 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL'];
  assert.deepEqual(launch.keys.filter((key: string) => !allowed.includes(key)), []);
  assert.ok(launch.keys.includes('PATH'));
});

test('Codex probe completes the handshake, lists skills for the pinned directory and ignores server messages', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const codexExecutable = await fixture('codex', codexSource(root, JSON.stringify([
    { name: 'work-pets:create-pet', description: 'Long.', shortDescription: null, interface: { displayName: 'Create Pet', shortDescription: 'Create a pet.' },
      path: '/home/synthetic/.codex/skills/create-pet/SKILL.md', scope: 'user', enabled: true },
    { name: 'skill-creator', description: 'Create or update a skill.', interface: null, path: '/home/synthetic/skill-creator/SKILL.md', scope: 'system', enabled: true },
    { name: 'disabled', description: 'Off.', scope: 'user', enabled: false },
  ])));
  const catalog = await new CliCommandCatalogReader({ codexExecutable, codexSettle: FAST }).read('codex', workdir, open());
  assert.deepEqual(validateCommandCatalog(catalog), { version: 1, provider: 'codex', truncated: false, entries: [
    { kind: 'skill', name: 'work-pets:create-pet', label: 'Create Pet', description: 'Create a pet.', argumentHint: null, builtin: false },
    { kind: 'skill', name: 'skill-creator', label: null, description: 'Create or update a skill.', argumentHint: null, builtin: true },
  ] });
  assert.equal(JSON.stringify(catalog).includes('synthetic'), false);
  const launch = JSON.parse((await readFile(join(root, 'launches'), 'utf8')).trim());
  assert.equal(launch.cwd, workdir.cwd);
  assert.deepEqual(launch.args, ['app-server', '--stdio']);
  assert.equal(launch.keys.some((key: string) => key.startsWith('CLAUDE_CODE_') || key === 'ENABLE_CLAUDEAI_MCP_SERVERS'), false);
  const requests = (await readFile(join(root, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.slice(0, 2).map(request => request.method), ['initialize', 'initialized']);
  const lists = requests.slice(2);
  assert.ok(lists.length >= 2);
  assert.deepEqual(lists, lists.map((_, index) => ({ id: index + 1, method: 'skills/list', params: { cwds: [workdir.cwd] } })));
});

test('a replaced project directory or an unsafe executable never launches a provider', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const claudeExecutable = await fixture('claude', claudeSource(root, '[]'));
  const codexExecutable = await fixture('codex', codexSource(root, '[]'));
  const reader = new CliCommandCatalogReader({ claudeExecutable, codexExecutable });
  const foreign: CommandCatalogWorkdir = { cwd: workdir.cwd, identity: { dev: workdir.identity.dev, ino: workdir.identity.ino + 1 } };
  await assert.rejects(reader.read('claudeCode', foreign, open()), { message: 'usage_unavailable' });
  await assert.rejects(reader.read('codex', foreign, open()), { message: 'usage_unavailable' });
  await assert.rejects(reader.read('codex', { ...workdir, cwd: 'relative' }, open()), { message: 'usage_unavailable' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(reader.read('claudeCode', workdir, aborted.signal));
  await assert.rejects(readFile(join(root, 'launches')), { code: 'ENOENT' });
  for (const options of [{ claudeExecutable: 'bin/claude' }, { codexExecutable: './codex' }, { claudeExecutable: '' }, { codexExecutable: '/bin/codex\0' }])
    assert.throws(() => new CliCommandCatalogReader(options), { message: 'invalid_provider_executable' });
});

test('failed, foreign, malformed and non-zero provider replies fail closed', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const claude = async (name: string, source: string) => new CliCommandCatalogReader({ claudeExecutable: await fixture(name, source), timeoutMs: 5_000 });
  const codex = async (name: string, source: string) => new CliCommandCatalogReader({ codexExecutable: await fixture(name, source), timeoutMs: 5_000, codexSettle: FAST });
  const reply = (body: string) => `let input = ''; process.stdin.setEncoding('utf8').on('data', chunk => { input += chunk; }).on('end', () => { const id = JSON.parse(input).request_id; ${body} });`;
  const failures = [
    await claude('claude-exit', claudeSource(root, '[{ name: "pr" }]', 'process.exitCode = 3;')),
    await claude('claude-error', reply(`console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'secret' } }));`)),
    await claude('claude-foreign', reply(`console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id + '-foreign', response: { commands: [{ name: 'pr' }] } } }));`)),
    await claude('claude-no-commands', reply(`console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: [] } } }));`)),
    await claude('claude-empty', reply('')),
    await claude('claude-invalid-utf8', reply(`process.stdout.write(Buffer.from([0xff, 0x0a]));`)),
  ];
  for (const reader of failures) await assert.rejects(reader.read('claudeCode', workdir, open()));
  const accepted = await claude('claude-control', reply(`console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { commands: [{ name: 'pr' }] } } }));`));
  assert.deepEqual((await accepted.read('claudeCode', workdir, open())).entries.map(entry => entry.name), ['pr']);
  const line = (body: string) => `require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); ${body} }); setInterval(() => {}, 1000);`;
  const codexFailures = [
    await codex('codex-init-error', line(`if (request.id === 0) console.log(JSON.stringify({ id: 0, error: { message: 'secret' } }));`)),
    await codex('codex-other-directory', line(`if (request.id !== undefined) console.log(JSON.stringify(request.id === 0 ? { id: 0, result: {} } : { id: request.id, result: { data: [{ cwd: '/elsewhere', skills: [{ name: 'foreign' }] }] } }));`)),
    await codex('codex-twin-listing', line(`if (request.id !== undefined) console.log(JSON.stringify(request.id === 0 ? { id: 0, result: {} } : { id: request.id, result: { data: [1, 2].map(() => ({ cwd: request.params.cwds[0], skills: [{ name: 'pet' }] })) } }));`)),
    await codex('codex-list-error', line(`if (request.id !== undefined) console.log(JSON.stringify(request.id === 0 ? { id: 0, result: {} } : { id: 1, error: { message: 'secret' } }));`)),
    await codex('codex-no-data', line(`if (request.id !== undefined) console.log(JSON.stringify({ id: request.id, result: {} }));`)),
    await codex('codex-not-json', line(`if (request.id === 0) console.log('not json');`)),
    await codex('codex-exit', `process.exit(0);`),
  ];
  for (const reader of codexFailures) await assert.rejects(reader.read('codex', workdir, open()));
  const listed = await codex('codex-control', line(`if (request.id !== undefined) console.log(JSON.stringify(request.id === 0 ? { id: 0, result: {} } : { id: request.id, result: { data: [{ cwd: '/elsewhere', skills: [{ name: 'foreign' }] }, { cwd: request.params.cwds[0], skills: [{ name: 'pet' }], errors: ['broken'] }] } }));`));
  const partial = await listed.read('codex', workdir, open());
  assert.deepEqual([partial.truncated, partial.entries.map(entry => entry.name)], [true, ['pet']]);
  for (const settle of [{ pollMs: 0 }, { settleMs: -1 }, { capMs: Number.NaN }])
    assert.throws(() => new CliCommandCatalogReader({ codexSettle: settle }), { message: 'invalid_codex_settle' });
});

test('one reply is capped at 2 MiB while accumulated Codex polls are bounded separately', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const many = `Array.from({ length: 600 }, (_, index) => ({ name: 'c' + index, description: 'd'.repeat(3000) }))`;
  const bounded = new CliCommandCatalogReader({ claudeExecutable: await fixture('claude', claudeSource(root, many)),
    codexExecutable: await fixture('codex', codexSource(root, many)), codexSettle: { pollMs: 50, settleMs: 200, capMs: 5_000 } });
  for (const provider of ['claudeCode', 'codex'] as const) {
    const catalog = validateCommandCatalog(await bounded.read(provider, workdir, open()));
    assert.equal(catalog.truncated, true);
    assert.equal(catalog.entries.length, 512);
    assert.equal(catalog.entries[511]?.name, 'c511');
    assert.equal(catalog.entries[0]?.description, 'd'.repeat(512));
  }
  const requests = (await readFile(join(root, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const polls = requests.filter(request => request.method === 'skills/list').length;
  assert.ok(polls >= 2 && polls * 600 * 3000 > 2 * 1024 * 1024 && polls * 600 * 3100 < 16 * 1024 * 1024, String(polls));
  const padding = (key: string, bytes: number, when = 'true') => `if (${when}) process.stdout.write(JSON.stringify({ ${key}, padding: 'x'.repeat(${bytes}) }) + '\\n');`;
  const claude = async (name: string, bytes: number) => new CliCommandCatalogReader({ timeoutMs: 10_000,
    claudeExecutable: await fixture(name, claudeSource(root, '[{ name: "pr" }]', padding(`type: 'system'`, bytes))) });
  const codex = async (name: string, bytes: number, when: string, settle = FAST) => new CliCommandCatalogReader({ timeoutMs: 10_000, codexSettle: settle,
    codexExecutable: await fixture(name, codexSource(root, '[{ name: "pr" }]', padding(`method: 'notice'`, bytes, when))) });
  const cap = 2 * 1024 * 1024;
  assert.deepEqual((await (await claude('claude-inside', cap - 4096)).read('claudeCode', workdir, open())).entries.map(entry => entry.name), ['pr']);
  assert.deepEqual((await (await codex('codex-inside', cap - 4096, 'polls <= 3')).read('codex', workdir, open())).entries.map(entry => entry.name), ['pr']);
  const failures = [
    ['claudeCode', await claude('claude-oversized', cap)],
    ['codex', await codex('codex-oversized-line', cap, 'polls === 2')],
    ['codex', await codex('codex-oversized-total', cap - 4096, 'true', { pollMs: 10, settleMs: 8_000, capMs: 9_000 })],
  ] as const;
  for (const [provider, reader] of failures) {
    const started = Date.now();
    await assert.rejects(reader.read(provider, workdir, open()), { message: 'usage_unavailable' });
    assert.ok(Date.now() - started < 7_000, provider);
  }
});

test('Codex polling returns the grown skill list once the names stop changing', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const baseline = timers();
  const codexExecutable = await fixture('codex', pollingSource(root, `reply(poll < 2 ? ['system-a'] : ['system-a', 'user-b', 'user-c']);`));
  const started = Date.now();
  const catalog = await new CliCommandCatalogReader({ codexExecutable, codexSettle: { pollMs: 10, settleMs: 600, capMs: 10_000 } }).read('codex', workdir, open());
  assert.deepEqual(catalog.entries.map(entry => entry.name), ['system-a', 'user-b', 'user-c']);
  assert.ok(Date.now() - started >= 600 && Date.now() - started < 6_000);
  const polls = await pollLog(root);
  assert.ok(polls.length >= 3);
  assert.deepEqual(polls.map(poll => poll.id), polls.map((_, index) => index + 1));
  assert.ok(polls.every(poll => poll.pending === 1 && poll.cwds.length === 1 && poll.cwds[0] === workdir.cwd));
  await assertReaped(await readPid(join(root, 'pid')));
  assert.equal(timers(), baseline);
});

test('Codex polling returns an unchanged list after the settle window and a changing list at the hard cap', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const baseline = timers();
  const steady = await fixture('steady', pollingSource(root, `reply(['only']);`));
  let started = Date.now();
  const settled = await new CliCommandCatalogReader({ codexExecutable: steady, codexSettle: { pollMs: 10, settleMs: 400, capMs: 10_000 } }).read('codex', workdir, open());
  assert.deepEqual(settled.entries.map(entry => entry.name), ['only']);
  assert.ok(Date.now() - started >= 400 && Date.now() - started < 6_000);
  assert.ok((await pollLog(root)).length >= 2);
  await rm(join(root, 'polls'));

  const restless = await fixture('restless', pollingSource(root, `reply(['c' + poll]);`));
  started = Date.now();
  const capped = await new CliCommandCatalogReader({ codexExecutable: restless, codexSettle: { pollMs: 10, settleMs: 400, capMs: 900 } }).read('codex', workdir, open());
  assert.ok(Date.now() - started >= 900 && Date.now() - started < 6_000);
  const polls = await pollLog(root);
  assert.ok(polls.length >= 3 && polls.every(poll => poll.pending === 1));
  assert.equal(capped.entries.length, 1);
  assert.ok([`c${polls.length}`, `c${polls.length - 1}`].includes(capped.entries[0]!.name), capped.entries[0]!.name);
  await assertReaped(await readPid(join(root, 'pid')));
  assert.equal(timers(), baseline);
});

test('an error on a later Codex poll fails and an abort during polling kills the process and clears timers', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const baseline = timers();
  const slow = { pollMs: 10, settleMs: 8_000, capMs: 9_000 };
  const failing = await fixture('failing', pollingSource(root, `poll < 3 ? reply(['system-a']) : send({ id: request.id, error: { code: -32000, message: 'secret' } });`));
  let started = Date.now();
  await assert.rejects(new CliCommandCatalogReader({ codexExecutable: failing, codexSettle: slow }).read('codex', workdir, open()), { message: 'usage_unavailable' });
  assert.ok(Date.now() - started < 6_000);
  assert.equal((await pollLog(root)).length, 3);
  await assertReaped(await readPid(join(root, 'pid')));
  assert.equal(timers(), baseline);
  await rm(join(root, 'polls')); await rm(join(root, 'pid'));

  const restless = await fixture('restless', pollingSource(root, `reply(['c' + poll]);`));
  const abort = new AbortController();
  started = Date.now();
  const pending = assert.rejects(new CliCommandCatalogReader({ codexExecutable: restless, codexSettle: slow }).read('codex', workdir, abort.signal));
  const until = Date.now() + 8_000;
  while ((await pollLog(root)).length < 3) {
    assert.ok(Date.now() < until, 'Codex polling never started');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const active = await readPid(join(root, 'pid'));
  abort.abort();
  await pending;
  assert.ok(Date.now() - started < 7_000);
  await assertReaped(active);
  const answered = (await pollLog(root)).length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await pollLog(root)).length, answered);
  assert.equal(timers(), baseline);
});

test('a Codex CLI that exits non-zero by itself after its settling reply is not a catalog', async t => {
  if (process.platform !== 'linux') return t.skip('Linux process state test.');
  const { root, workdir, fixture } = await workspace(t);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const exited = (pid: number): boolean => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch { return true; }
  };
  for (const code of [0, 3]) {
    const marker = join(root, `exiting-${code}`), release = join(root, `release-${code}`);
    const codexExecutable = await fixture(`codex-exit-${code}`, `
const fs = require('node:fs'); const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let polls = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') return;
  if (request.id === 0) return send({ id: 0, result: {} });
  const reply = () => send({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'pet' }], errors: [] }] } });
  if (++polls < 2) return reply();
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { reply(); process.exit(${code}); } }, 5);
});
setInterval(() => {}, 1000);`);
    const reader = new CliCommandCatalogReader({ codexExecutable, timeoutMs: 10_000, codexSettle: { pollMs: 10, settleMs: 1, capMs: 9_000 } });
    const outcome = reader.read('codex', workdir, open()).then(catalog => catalog.entries.map(entry => entry.name), () => 'rejected');
    let pid = 0;
    while (!(pid > 0)) pid = await readPid(marker);
    assert.equal(exited(pid), false);
    writeFileSync(release, '');
    const until = Date.now() + 8_000;
    while (!exited(pid) && Date.now() < until) Atomics.wait(pause, 0, 0, 20);
    assert.ok(exited(pid), 'Codex fixture exited by itself before the reader observed its last reply');
    assert.deepEqual(await outcome, code === 0 ? ['pet'] : 'rejected', String(code));
  }
});

test('timeout and abort kill the whole provider process tree', async t => {
  const { root, workdir, fixture } = await workspace(t);
  const baseline = timers();
  const executable = await fixture('hanging', hangingSource(root));
  const pidPath = join(root, 'pid'), descendantPath = join(root, 'descendant-pid');
  for (const provider of ['claudeCode', 'codex'] as const) {
    const started = Date.now();
    await assert.rejects(new CliCommandCatalogReader({ claudeExecutable: executable, codexExecutable: executable, timeoutMs: 3_000 }).read(provider, workdir, open()), { message: 'usage_unavailable' });
    assert.ok(Date.now() - started >= 2_900 && Date.now() - started < 9_000, provider);
    await assertReaped(await readPid(pidPath));
    await assertReaped(await readPid(descendantPath));
    await rm(pidPath); await rm(descendantPath);
  }
  const abort = new AbortController();
  const pending = assert.rejects(new CliCommandCatalogReader({ codexExecutable: executable }).read('codex', workdir, abort.signal));
  const active = await readPid(pidPath), child = await readPid(descendantPath);
  abort.abort();
  await pending;
  await assertReaped(active); await assertReaped(child);
  assert.equal(timers(), baseline);
});
