import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from './domain/contracts.js';
import { SERVICES, type RunnerServices } from './transport/services.js';
import { handle, send } from './transport/http.js';
@Controller('v1/history')
export class HistorySearchController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get('search')
  search(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.historySearch) throw new RunnerError('not_found');
      if (request.url.length > 4096) throw new RunnerError('invalid_input');
      const params = new URL(request.url, 'http://runner.invalid').searchParams;
      const values: Record<string, unknown> = {};
      for (const [key, value] of params) {
        if (Object.hasOwn(values, key) || !['q', 'after', 'projectId'].includes(key)) throw new RunnerError('invalid_input');
        values[key] = value;
      }
      if (values.after !== undefined && (typeof values.after !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(values.after))) throw new RunnerError('invalid_input');
      values.after = values.after === undefined ? 0 : Number(values.after);
      send(response, 200, await this.services.historySearch.search(values));
    });
  }
}
