import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';
@Controller('v1/tasks/:taskId/artifacts')
export class ArtifactController {
  private downloads = 0;
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Post()
  register(@Param('taskId') taskId: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.artifacts) throw new RunnerError('not_found');
      const result = await this.services.artifacts.register(taskId, await jsonBody(request));
      send(response, result.created ? 201 : 200, result);
    });
  }
  @Get()
  list(@Param('taskId') taskId: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.artifacts) throw new RunnerError('not_found');
      send(response, 200, await this.services.artifacts.list(taskId));
    });
  }
  @Get(':id/content')
  content(@Param('taskId') taskId: string, @Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.artifacts) throw new RunnerError('not_found');
      if (this.downloads >= 2) throw new RunnerError('busy');
      this.downloads++;
      let complete!: () => void;
      const completion = new Promise<void>(resolve => { complete = resolve; });
      response.once('finish', complete); response.once('close', complete);
      try {
        const { artifact, bytes } = await this.services.artifacts.read(taskId, id);
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, { 'content-type': artifact.mediaType, 'content-length': bytes.byteLength,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'content-disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` });
        response.end(bytes); await completion;
      } finally { response.off('finish', complete); response.off('close', complete); this.downloads--; }
    });
  }
}
