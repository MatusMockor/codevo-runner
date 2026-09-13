import { Controller, Get, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LIMITS, RunnerError } from '../domain/contracts.js';
import { cursor, handle, jsonBody, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/tasks')
export class TaskController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Post()
  create(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const result = await this.services.tasks.create(await jsonBody(request));
      send(response, result.created ? 201 : 200, result);
    });
  }

  @Get()
  list(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.services.tasks.list(cursor(request))));
  }

  @Get(':id')
  get(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.services.tasks.get(id)));
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      const tasks = this.services.execution ?? this.services.tasks;
      send(response, 200, await tasks.cancel(id));
    });
  }

  @Post(':id/start')
  start(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution) throw new RunnerError('not_found');
      const task = await this.services.execution.start(id, await jsonBody(request));
      send(response, 202, task);
    });
  }

  @Get(':id/resume')
  resume(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution) throw new RunnerError('not_found');
      send(response, 200, await this.services.execution.resumeState(id));
    });
  }

  @Post(':id/continue')
  continue(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution) throw new RunnerError('not_found');
      const result = await this.services.execution.continue(id, await jsonBody(request));
      send(response, result.created ? 202 : 200, result);
    });
  }

  @Get(':id/diff')
  diff(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution) throw new RunnerError('not_found');
      send(response, 200, await this.services.execution.diff(id));
    });
  }

  @Get(':id/events')
  events(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.services.tasks.events(id, cursor(request))));
  }
}

@Controller('v1/project-clones')
export class ProjectCloneController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Get(':id')
  get(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.clones) throw new RunnerError('not_found');
      send(response, 200, await this.services.clones.get(id));
    });
  }
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.clones) throw new RunnerError('not_found');
      send(response, 200, await this.services.clones.cancel(id));
    });
  }
}

@Controller('v1/projects')
export class ProjectController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  @Post('clone')
  clone(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.clones) throw new RunnerError('not_found');
      send(response, 202, await this.services.clones.create(await jsonBody(request)));
    });
  }


  @Get()
  list(@Res() response: Response) {
    return handle(response, async () => {
      if (!this.services.execution) throw new RunnerError('not_found');
      send(response, 200, { items: await this.services.execution.projects() });
    });
  }
}

function fileName(request: Request): string {
  const value = request.headers['x-file-name'];
  if (typeof value !== 'string' || !value.length) throw new RunnerError('invalid_input');
  try { return decodeURIComponent(value); }
  catch { throw new RunnerError('invalid_input'); }
}

@Controller('v1/attachments')
export class AttachmentController {
  private downloads = 0;
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Put(':id')
  upload(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const mediaType = request.headers['content-type'];
      if (request.headers['content-encoding'] || (mediaType !== 'image/png' && mediaType !== 'image/jpeg'))
        throw new RunnerError('unsupported_media');
      if (Number(request.headers['content-length'] ?? 0) > LIMITS.attachmentBytes)
        throw new RunnerError('too_large');
      const name = fileName(request);
      const controller = new AbortController();
      const aborted = () => controller.abort();
      request.once('aborted', aborted);
      response.once('close', aborted);
      const timer = setTimeout(() => {
        controller.abort();
        // End a stalled request even when its source iterator is waiting for bytes.
        if (!response.headersSent) send(response, 408, { error: 'request_timeout' });
        request.destroy();
      }, LIMITS.uploadTimeoutMs);
      timer.unref();
      try {
        const result = await this.services.attachments.upload(
          id, name, mediaType, request.iterator({ destroyOnReturn: false }), controller.signal,
        );
        if (!response.destroyed && !response.headersSent) send(response, result.created ? 201 : 200, result);
      } finally {
        clearTimeout(timer);
        request.off('aborted', aborted);
        response.off('close', aborted);
      }
    });
  }

  @Get(':id')
  metadata(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, await this.services.attachments.metadata(id)));
  }

  @Get(':id/content')
  content(@Param('id') id: string, @Res() response: Response) {
    return handle(response, async () => {
      if (this.downloads >= 2) throw new RunnerError('busy');
      this.downloads++;
      let completed!: () => void;
      const completion = new Promise<void>(resolve => { completed = resolve; });
      response.once('finish', completed);
      response.once('close', completed);
      try {
        const { attachment, bytes } = await this.services.attachments.read(id);
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, {
          'content-type': attachment.mediaType,
          'content-length': bytes.byteLength,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename="image"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          connection: 'close',
        });
        response.end(bytes);
        // Hold admission while a slow client still retains the response buffer.
        await completion;
      } finally {
        response.off('finish', completed);
        response.off('close', completed);
        this.downloads--;
      }
    });
  }
}
