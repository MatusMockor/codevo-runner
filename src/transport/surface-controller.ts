import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import type { SurfaceOperation } from '../domain/surface-files.js';
import { SERVICES, type RunnerServices } from './services.js';
import { handle, jsonBody, send } from './http.js';

@Controller('v1/projects/:projectId/surface')
export class SurfaceController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get('capabilities')
  capabilities(@Param('projectId') projectId: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.surfaces) throw new RunnerError('not_found');
      send(response, 200, { ...await this.services.surfaces.capabilities(projectId), terminal: Boolean(this.services.terminals) });
    });
  }
  @Post(':operation')
  perform(@Param('projectId') projectId: string, @Param('operation') operation: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.surfaces) throw new RunnerError('not_found');
      if (!['tree', 'read', 'write', 'history', 'commit-files', 'commit-diff'].includes(operation)) throw new RunnerError('not_found');
      send(response, 200, await this.services.surfaces.perform(projectId, operation as SurfaceOperation, await jsonBody(request)));
    });
  }
}
