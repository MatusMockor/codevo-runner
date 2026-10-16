import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { McpServersWorkdir } from '../src/application/mcp-servers-service.js';
import { mcpDeviceLaunchDigest } from '../src/domain/mcp-device-sync.js';
import { CLAUDE_LOCAL_CONFIG_BYTES, FileClaudeLocalConfig, claudeConfigPath } from '../src/infrastructure/execution/claude-local-config.js';
import { CliMcpDeviceSyncExecutor } from '../src/infrastructure/execution/mcp-device-sync.js';
import { FileMcpDeviceSyncLedger } from '../src/infrastructure/files/mcp-device-sync-ledger.js';

const unavailable = { name: 'RunnerError', code: 'storage_unavailable' };
const live = () => new AbortController().signal;
const digest = mcpDeviceLaunchDigest({ kind: 'stdio', command: 'npx', args: [], env: [] });

async function scratch(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-mcp-device-sync-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function workdir(root: string): Promise<McpServersWorkdir> {
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const info = await lstat(cwd);
  return { cwd, identity: { dev: info.dev, ino: info.ino } };
}

test('the Claude config path follows CLAUDE_CONFIG_DIR, then HOME, and refuses relative locations', () => {
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/srv/claude', HOME: '/home/u' }), '/srv/claude/.claude.json');
  assert.equal(claudeConfigPath({ HOME: '/home/u' }), '/home/u/.claude.json');
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: 'relative', HOME: '/home/u' }), null);
  assert.equal(claudeConfigPath({ HOME: 'relative' }), null);
});

test('the config reader projects only the requested names of the exact project key', async t => {
  const root = await scratch(t);
  const project = await workdir(root);
  const path = join(root, '.claude.json');
  await writeFile(path, JSON.stringify({ mcpServers: { user: { command: 'u' } }, projects: {
    [project.cwd]: { mcpServers: { docs: { command: 'npx' }, own: { command: 'own' }, odd: { type: 'ws', url: 'wss://x' } } },
    [`${project.cwd}/nested`]: { mcpServers: { nested: { command: 'n' } } },
  } }));
  const found = await new FileClaudeLocalConfig(path).read(project, new Set(['docs', 'odd', 'user', 'nested', 'absent']), live());
  assert.deepEqual([...found.keys()], ['docs', 'odd']);
  assert.deepEqual(found.get('docs'), { kind: 'recognized', launch: { kind: 'stdio', command: 'npx', args: [], env: [] } });
  assert.deepEqual(found.get('odd'), { kind: 'unrecognized' });
  assert.equal((await new FileClaudeLocalConfig(path).read(project, new Set(), live())).size, 0);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ mcpServers: { user: { command: 'u' } }, projects: {
    [project.cwd]: { mcpServers: { docs: { command: 'npx' }, own: { command: 'own' }, odd: { type: 'ws', url: 'wss://x' } } },
    [`${project.cwd}/nested`]: { mcpServers: { nested: { command: 'n' } } },
  } }));
});

test('a missing or empty config is empty, an oversized, malformed or non-file config is unavailable', async t => {
  const root = await scratch(t);
  const project = await workdir(root);
  const names = new Set(['docs']);
  assert.equal((await new FileClaudeLocalConfig(join(root, 'missing.json')).read(project, names, live())).size, 0);
  await writeFile(join(root, 'empty.json'), '');
  assert.equal((await new FileClaudeLocalConfig(join(root, 'empty.json')).read(project, names, live())).size, 0);
  await writeFile(join(root, 'big.json'), JSON.stringify({ pad: 'x'.repeat(200) }));
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'big.json'), 100).read(project, names, live()), unavailable);
  await writeFile(join(root, 'bad.json'), '{"projects":');
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'bad.json')).read(project, names, live()), unavailable);
  await writeFile(join(root, 'array.json'), '[]');
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'array.json')).read(project, names, live()), unavailable);
  await writeFile(join(root, 'latin.json'), Buffer.from([0x7b, 0xff, 0x7d]));
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'latin.json')).read(project, names, live()), unavailable);
  await assert.rejects(new FileClaudeLocalConfig(root).read(project, names, live()), unavailable);
  await assert.rejects(new FileClaudeLocalConfig(null).read(project, names, live()), unavailable);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'missing.json')).read(project, names, aborted.signal));
  assert.equal(CLAUDE_LOCAL_CONFIG_BYTES, 32 * 1024 * 1024);
});

test('a config exactly at the byte limit is read', async t => {
  const root = await scratch(t);
  const project = await workdir(root);
  const body = JSON.stringify({ projects: { [project.cwd]: { mcpServers: { docs: { command: 'npx' } } } } });
  await writeFile(join(root, 'exact.json'), body);
  assert.equal((await new FileClaudeLocalConfig(join(root, 'exact.json'), Buffer.byteLength(body)).read(project, new Set(['docs']), live())).size, 1);
  await assert.rejects(new FileClaudeLocalConfig(join(root, 'exact.json'), Buffer.byteLength(body) - 1).read(project, new Set(['docs']), live()), unavailable);
});

test('the ledger is written atomically with owner-only permissions and holds names and digests only', async t => {
  const root = await scratch(t);
  const ledgers = new FileMcpDeviceSyncLedger(root);
  assert.deepEqual(await ledgers.load('example', live()), { kind: 'valid', servers: new Map() });
  await ledgers.save('example', new Map([['docs', digest]]), live());
  const directory = join(root, 'mcp-device-sync');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'example.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'example.json'), 'utf8')), { version: 1, servers: [{ name: 'docs', digest }] });
  assert.deepEqual(await ledgers.load('example', live()), { kind: 'valid', servers: new Map([['docs', digest]]) });
  await ledgers.save('example', new Map(), live());
  assert.deepEqual(await ledgers.load('example', live()), { kind: 'valid', servers: new Map() });
  assert.deepEqual(await readdir(directory), ['example.json']);
  assert.deepEqual(await ledgers.load('other', live()), { kind: 'valid', servers: new Map() });
  await assert.rejects(ledgers.save('../escape', new Map(), live()), { name: 'RunnerError', code: 'not_found' });
});

test('a corrupt, oversized or symlinked ledger is reported corrupt so nothing is removed', async t => {
  const root = await scratch(t);
  const directory = join(root, 'mcp-device-sync');
  await mkdir(directory, { recursive: true });
  const ledgers = new FileMcpDeviceSyncLedger(root);
  await writeFile(join(directory, 'broken.json'), '{"version":1,');
  assert.deepEqual(await ledgers.load('broken', live()), { kind: 'corrupt' });
  await writeFile(join(directory, 'shape.json'), JSON.stringify({ version: 1, servers: [{ name: 'docs', digest: 'nothex' }] }));
  assert.deepEqual(await ledgers.load('shape', live()), { kind: 'corrupt' });
  await writeFile(join(directory, 'big.json'), ' '.repeat(64 * 1024 + 1));
  assert.deepEqual(await ledgers.load('big', live()), { kind: 'corrupt' });
  await writeFile(join(root, 'elsewhere.json'), JSON.stringify({ version: 1, servers: [] }));
  await symlink(join(root, 'elsewhere.json'), join(directory, 'linked.json'));
  assert.deepEqual(await ledgers.load('linked', live()), { kind: 'corrupt' });
  await mkdir(join(directory, 'folder.json'));
  assert.deepEqual(await ledgers.load('folder', live()), { kind: 'corrupt' });
  await ledgers.save('linked', new Map([['docs', digest]]), live());
  assert.equal((await lstat(join(directory, 'linked.json'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(root, 'elsewhere.json'), 'utf8'), JSON.stringify({ version: 1, servers: [] }));
});

test('a ledger directory replaced by a symlink is refused on save', async t => {
  const root = await scratch(t);
  await mkdir(join(root, 'target'));
  await symlink(join(root, 'target'), join(root, 'mcp-device-sync'));
  await assert.rejects(new FileMcpDeviceSyncLedger(root).save('example', new Map(), live()), unavailable);
  assert.deepEqual(await readdir(join(root, 'target')), []);
});

test('stdio commands resolve on the provider PATH or as executable paths only', async t => {
  const root = await scratch(t);
  const project = await workdir(root);
  const executor = new CliMcpDeviceSyncExecutor();
  assert.equal(await executor.available('sh', project, live()), true);
  assert.equal(await executor.available('codevo-definitely-missing-command', project, live()), false);
  assert.equal(await executor.available('/bin/sh', project, live()), true);
  assert.equal(await executor.available('/Users/someone/.local/bin/server', project, live()), false);
  await writeFile(join(project.cwd, 'tool'), '#!/bin/sh\n');
  assert.equal(await executor.available('./tool', project, live()), false);
  await chmod(join(project.cwd, 'tool'), 0o700);
  assert.equal(await executor.available('./tool', project, live()), true);
  await mkdir(join(project.cwd, 'dir'));
  assert.equal(await executor.available('./dir', project, live()), false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(executor.available('sh', project, aborted.signal));
});
