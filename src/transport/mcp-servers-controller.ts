import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { isMcpServersProvider } from '../domain/mcp-servers.js';
import { handle, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/projects')
export class McpServersController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':projectId/mcp-servers/:provider')
  read(@Param('projectId') projectId: string, @Param('provider') provider: string, @Res() response: Response) {
    return handle(response, async () => {
      const mcpServers = this.services.mcpServers;
      if (!mcpServers || !isMcpServersProvider(provider)) throw new RunnerError('not_found');
      const disconnection = new AbortController();
      const disconnected = () => disconnection.abort();
      response.once('close', disconnected);
      try { send(response, 200, await mcpServers.read(projectId, provider, disconnection.signal)); }
      finally { response.off('close', disconnected); }
    });
  }
}
