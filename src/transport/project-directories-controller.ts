import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, DESCRIPTOR, type RunnerServices } from './services.js';
import type { RunnerDescriptor } from '../server.js';

@Controller('v1/project-directories')
export class ProjectDirectoriesController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices,
    @Inject(DESCRIPTOR) private readonly descriptor: RunnerDescriptor) {}
  @Post()
  list(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (request.headers['x-codevo-runner-id'] !== this.descriptor.runnerId) throw new RunnerError('conflict');
      if (!this.services.projectDirectories) throw new RunnerError('not_found');
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, 10_000);
      response.once('close', abort);
      try {
        const result = await this.services.projectDirectories.list(await jsonBody(request, 8192), controller.signal);
        if (!response.destroyed) send(response, 200, result);
      } finally { clearTimeout(timeout); response.off('close', abort); }
    });
  }
}
