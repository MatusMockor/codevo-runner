import { Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { McpServerManagementApplication } from '../application/mcp-server-management-service.js';
import { RunnerError } from '../domain/contracts.js';
import { isMcpServersProvider, type McpServersProvider } from '../domain/mcp-servers.js';
import { handle, jsonBody, send } from './http.js';
import { LeaseExempt } from './lease-exempt.js';
import { SERVICES, type RunnerServices } from './services.js';

const CHANGE_BODY_BYTES = 96 * 1024;
const LOGIN_BODY_BYTES = 1024;
const CALLBACK_BODY_BYTES = 16 * 1024;

type Target = Readonly<{ management: McpServerManagementApplication; provider: McpServersProvider }>;

@Controller('v1/projects')
export class McpServerManagementController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Post(':projectId/mcp-servers/:provider/changes')
  change(@Param('projectId') projectId: string, @Param('provider') provider: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const target = this.target(provider);
      send(response, 200, await target.management.change(projectId, target.provider, await jsonBody(request, CHANGE_BODY_BYTES)));
    });
  }

  @Post(':projectId/mcp-servers/:provider/logins')
  startLogin(@Param('projectId') projectId: string, @Param('provider') provider: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const target = this.target(provider);
      const disconnection = new AbortController();
      const disconnected = () => disconnection.abort();
      response.once('close', disconnected);
      try { send(response, 200, await target.management.startLogin(projectId, target.provider, await jsonBody(request, LOGIN_BODY_BYTES), disconnection.signal)); }
      finally { response.off('close', disconnected); }
    });
  }

  @Get(':projectId/mcp-servers/:provider/logins/:loginId')
  @LeaseExempt('storage-read')
  loginState(@Param('projectId') projectId: string, @Param('provider') provider: string, @Param('loginId') loginId: string, @Res() response: Response) {
    return handle(response, async () => {
      const target = this.target(provider);
      send(response, 200, await target.management.loginState(projectId, target.provider, loginId));
    });
  }

  @Post(':projectId/mcp-servers/:provider/logins/:loginId/callback')
  submitLoginCallback(@Param('projectId') projectId: string, @Param('provider') provider: string, @Param('loginId') loginId: string,
    @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const target = this.target(provider);
      send(response, 200, await target.management.submitLoginCallback(projectId, target.provider, loginId, await jsonBody(request, CALLBACK_BODY_BYTES)));
    });
  }

  @Delete(':projectId/mcp-servers/:provider/logins/:loginId')
  cancelLogin(@Param('projectId') projectId: string, @Param('provider') provider: string, @Param('loginId') loginId: string, @Res() response: Response) {
    return handle(response, async () => {
      const target = this.target(provider);
      send(response, 200, await target.management.cancelLogin(projectId, target.provider, loginId));
    });
  }

  private target(provider: string): Target {
    const management = this.services.mcpServerManagement;
    if (!management || !isMcpServersProvider(provider)) throw new RunnerError('not_found');
    return { management, provider };
  }
}
