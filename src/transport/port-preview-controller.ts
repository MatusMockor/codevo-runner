import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PortPreviewApplication } from '../application/port-preview-ports.js';
import { RunnerError } from '../domain/contracts.js';
import { handle, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1')
export class PortPreviewController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Get('tasks/:id/ports')
  taskPorts(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.ports().taskPorts(id)));
  }

  @Get('projects/:projectId/ports')
  projectPorts(@Param('projectId') projectId: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.ports().projectPorts(projectId)));
  }

  private ports(): PortPreviewApplication {
    if (!this.services.ports) throw new RunnerError('not_found');
    return this.services.ports;
  }
}
