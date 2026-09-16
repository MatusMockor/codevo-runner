import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/tasks')
export class QuestionController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':id/questions')
  list(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.questions) throw new RunnerError('not_found');
      send(response, 200, { items: await this.services.questions.list(id) });
    });
  }
  @Post(':id/questions/:requestId/answer')
  answer(@Param('id') id: string, @Param('requestId') requestId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.questions) throw new RunnerError('not_found');
      send(response, 200, { request: await this.services.questions.answer(id, requestId, await jsonBody(request)) });
    });
  }
}
