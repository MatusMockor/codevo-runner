import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/projects')
export class CommandCatalogController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':projectId/command-catalog/:provider')
  read(@Param('projectId') projectId: string, @Param('provider') provider: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.commandCatalog || (provider !== 'claude' && provider !== 'codex')) throw new RunnerError('not_found');
      send(response, 200, await this.services.commandCatalog.read(projectId, provider === 'claude' ? 'claudeCode' : 'codex'));
    });
  }
}
