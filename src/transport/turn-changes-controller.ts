import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { SERVICES, type RunnerServices } from './services.js';
import { handle, jsonBody, send } from './http.js';

@Controller('v1/tasks')
export class TurnChangesController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':id/turn-changes')
  summary(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution?.turnSummary) throw new RunnerError('not_found');
      send(response, 200, await this.services.execution.turnSummary(id));
    });
  }
  @Post(':id/turn-file-diff')
  diff(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution?.turnFileDiff) throw new RunnerError('not_found');
      send(response, 200, await this.services.execution.turnFileDiff(id, await jsonBody(request, 8192)));
    });
  }
}
