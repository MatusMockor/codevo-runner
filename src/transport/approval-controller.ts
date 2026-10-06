import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

const ANSWER_BYTES = 4096;

@Controller('v1/tasks')
export class ApprovalController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Get(':id/approvals')
  list(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.approvals) throw new RunnerError('not_found');
      send(response, 200, { items: await this.services.approvals.list(id) });
    });
  }

  @Post(':id/approvals/:requestId/answer')
  answer(@Param('id') id: string, @Param('requestId') requestId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.approvals) throw new RunnerError('not_found');
      const body = await jsonBody(request, ANSWER_BYTES);
      send(response, 200, { request: await this.services.approvals.answer(id, requestId, body) });
    });
  }
}
