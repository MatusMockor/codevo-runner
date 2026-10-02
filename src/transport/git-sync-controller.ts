import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { GitSyncApplication } from '../application/git-sync-ports.js';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

const SMALL_BODY_BYTES = 1024;
const COMMIT_BODY_BYTES = 32 * 1024;

@Controller('v1')
export class GitSyncController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Get('projects/:projectId/git/branches')
  branches(@Param('projectId') projectId: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.sync().branches(projectId)));
  }

  @Get('projects/:projectId/git/status')
  projectStatus(@Param('projectId') projectId: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.sync().projectStatus(projectId)));
  }

  @Post('projects/:projectId/git/fetch')
  fetch(@Param('projectId') projectId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const sync = this.sync();
      send(response, 202, await sync.fetch(projectId, await jsonBody(request, SMALL_BODY_BYTES)));
    });
  }

  @Post('projects/:projectId/git/update')
  update(@Param('projectId') projectId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const sync = this.sync();
      send(response, 202, await sync.update(projectId, await jsonBody(request, SMALL_BODY_BYTES)));
    });
  }

  @Get('tasks/:id/git/status')
  threadStatus(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.sync().threadStatus(id)));
  }

  @Post('tasks/:id/git/commit')
  commit(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const sync = this.sync();
      send(response, 200, await sync.commit(id, await jsonBody(request, COMMIT_BODY_BYTES)));
    });
  }

  @Post('tasks/:id/git/push')
  push(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const sync = this.sync();
      send(response, 202, await sync.push(id, await jsonBody(request, SMALL_BODY_BYTES)));
    });
  }

  @Get('git-operations/:id')
  operation(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.sync().operation(id)));
  }

  private sync(): GitSyncApplication {
    if (!this.services.gitSync) throw new RunnerError('not_found');
    return this.services.gitSync;
  }
}
