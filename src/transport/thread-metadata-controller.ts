import { Controller, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { SERVICES, type RunnerServices } from './services.js';
import { handle, jsonBody, send } from './http.js';
@Controller('v1')
export class ThreadMetadataController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get('thread-metadata')
  list(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.threadMetadata) throw new RunnerError('not_found');
      if (request.url.length > 512) throw new RunnerError('invalid_input');
      const params = new URL(request.url, 'http://runner.invalid').searchParams;
      if ([...params.keys()].some(key => key !== 'after') || params.getAll('after').length > 1) throw new RunnerError('invalid_input');
      send(response, 200, await this.services.threadMetadata.list(params.get('after') ?? ''));
    });
  }
  @Get('tasks/:id/thread-metadata')
  get(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.threadMetadata) throw new RunnerError('not_found');
      send(response, 200, await this.services.threadMetadata.get(id));
    });
  }
  @Post('tasks/:id/thread-order')
  reorder(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.threadMetadata) throw new RunnerError('not_found');
      send(response, 200, await this.services.threadMetadata.reorder(id, await jsonBody(request, 4096)));
    });
  }
  @Patch('tasks/:id/thread-metadata')
  patch(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.threadMetadata) throw new RunnerError('not_found');
      send(response, 200, await this.services.threadMetadata.patch(id, await jsonBody(request, 4096)));
    });
  }
}
