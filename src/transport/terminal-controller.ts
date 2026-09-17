import { Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError, isId } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';
@Controller('v1/projects/:projectId/terminals')
export class TerminalController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  private service() { if (!this.services.terminals) throw new RunnerError('not_found'); return this.services.terminals; }
  private task(request: Request): string | undefined {
    const values = new URL(request.originalUrl, 'http://localhost').searchParams.getAll('taskId');
    if (values.length > 1 || (values.length === 1 && !isId(values[0]))) throw new RunnerError('invalid_input');
    return values[0];
  }
  @Post()
  open(@Param('projectId') projectId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.service().open(projectId, await jsonBody(request))));
  }
  @Get(':id')
  read(@Param('projectId') projectId: string, @Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const query = new URL(request.originalUrl, 'http://localhost').searchParams;
      if ([...query.keys()].some(key => key !== 'after' && key !== 'taskId') || query.getAll('after').length > 1 || !/^\d+$/.test(query.get('after') ?? '0')) throw new RunnerError('invalid_input');
      send(response, 200, await this.service().read(projectId, id, Number(query.get('after') ?? 0), this.task(request)));
    });
  }
  @Post(':id/input')
  input(@Param('projectId') projectId: string, @Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.service().input(projectId, id, await jsonBody(request), this.task(request))));
  }
  @Post(':id/resize')
  resize(@Param('projectId') projectId: string, @Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.service().resize(projectId, id, await jsonBody(request), this.task(request))));
  }
  @Delete(':id')
  close(@Param('projectId') projectId: string, @Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, this.service().closeSession(projectId, id, this.task(request))));
  }
}
