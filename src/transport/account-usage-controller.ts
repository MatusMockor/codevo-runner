import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/account-usage')
export class AccountUsageController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':provider')
  read(@Param('provider') provider: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.accountUsage || (provider !== 'claude' && provider !== 'codex')) throw new RunnerError('not_found');
      send(response, 200, await this.services.accountUsage.read(provider === 'claude' ? 'claudeCode' : 'codex'));
    });
  }
}
