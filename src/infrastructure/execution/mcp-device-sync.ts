import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { McpDeviceSyncExecutor } from '../../application/mcp-device-sync.js';
import type { McpServersWorkdir } from '../../application/mcp-servers-service.js';
import type { McpDeviceSyncStep } from '../../domain/mcp-device-sync.js';
import { claudeMcpAddJsonPlan, claudeMcpRemovePlan, type McpCliPlan } from '../../domain/mcp-server-management-cli.js';
import { providerEnvironment } from './cli-executor.js';
import { executable } from './command-catalog.js';
import { MCP_SERVER_CHANGE_TIMEOUT_MS, MCP_SERVER_MANAGEMENT_BYTES, type McpServerManagementCliOptions } from './mcp-server-management.js';
import { runProcess } from './process-runner.js';

const MAX_PATH_ENTRIES = 64;

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

function stepPlan(step: McpDeviceSyncStep): McpCliPlan {
  switch (step.kind) {
    case 'add': return claudeMcpAddJsonPlan(step.name, step.json);
    case 'remove': return claudeMcpRemovePlan({ kind: 'remove', name: step.name, scope: 'local' });
  }
}

export class CliMcpDeviceSyncExecutor implements McpDeviceSyncExecutor {
  private readonly claudeExecutable: string;
  private readonly timeoutMs: number;

  constructor(options: McpServerManagementCliOptions = {}) {
    this.claudeExecutable = executable(options.claudeExecutable, 'claude');
    this.timeoutMs = options.timeoutMs ?? MCP_SERVER_CHANGE_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error('invalid_mcp_device_sync_timing');
  }

  async available(command: string, workdir: McpServersWorkdir, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (command.includes('/')) return executableFile(isAbsolute(command) ? command : resolve(workdir.cwd, command));
    const directories = (providerEnvironment().PATH ?? '').split(delimiter).filter(isAbsolute).slice(0, MAX_PATH_ENTRIES);
    for (const directory of directories) {
      signal.throwIfAborted();
      if (await executableFile(join(directory, command))) return true;
    }
    return false;
  }

  async run(step: McpDeviceSyncStep, workdir: McpServersWorkdir, signal: AbortSignal): Promise<boolean> {
    const plan = stepPlan(step);
    const output = { stdout: '', stderr: '' };
    const result = await runProcess({ executable: this.claudeExecutable, args: plan.args, cwd: workdir.cwd, cwdIdentity: workdir.identity, stdin: '',
      env: providerEnvironment(), signal, timeoutMs: this.timeoutMs, outputBytes: MCP_SERVER_MANAGEMENT_BYTES.cliOutputBytes,
      onOutput: async (channel, text) => { output[channel] += text; } });
    if (result.error) return false;
    const outcome = plan.outcome(result.exitCode, `${output.stdout}\n${output.stderr}`);
    return outcome === 'ok' || (step.kind === 'remove' && outcome === 'notFound');
  }
}
