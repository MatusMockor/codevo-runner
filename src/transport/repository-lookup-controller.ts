import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { SERVICES, DESCRIPTOR, type RunnerServices } from './services.js';
import type { RunnerDescriptor } from '../server.js';
import { handle, jsonBody, send } from './http.js';

@Controller('v1/repositories')
export class RepositoryLookupController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices,
    @Inject(DESCRIPTOR) private readonly descriptor: RunnerDescriptor) {}
  @Get('hosts')
  hosts(@Req() request: Request, @Res() response: Response) {
    return this.perform(request, response, signal => this.services.repositories!.hosts(signal));
  }
  @Post('lookup')
  lookup(@Req() request: Request, @Res() response: Response) {
    return this.perform(request, response, async signal => this.services.repositories!.lookup(await jsonBody(request, 4096), signal));
  }
  @Post('search')
  search(@Req() request: Request, @Res() response: Response) {
    return this.perform(request, response, async signal => this.services.repositories!.search(await jsonBody(request, 4096), signal));
  }
  private perform(request: Request, response: Response, operation: (signal: AbortSignal) => Promise<unknown>) {
    return handle(response, async () => {
      if (!this.services.repositories) throw new RunnerError('not_found');
      if (request.headers['x-codevo-runner-id'] !== this.descriptor.runnerId) throw new RunnerError('conflict');
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once('close', abort);
      try {
        const result = await operation(controller.signal);
        if (!response.destroyed) send(response, 200, result);
      } finally { response.off('close', abort); }
    });
  }
}
