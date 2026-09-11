import 'reflect-metadata';
import { createServer, type ServerResponse } from 'node:http';
import {
  Controller, Get, Inject, Injectable, Module, Res,
  type INestApplication, type NestMiddleware,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

export type RunnerDescriptor = Readonly<{
  protocolVersion: 1;
  runnerId: string;
  name: string;
  capabilities: Readonly<{ taskExecution: false; eventReplay: false }>;
}>;

type Authorize = (header: string | undefined) => boolean;
const DESCRIPTOR = Symbol('runner descriptor');
const AUTHORIZE = Symbol('runner authorization');

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'connection': 'close',
  });
  response.end(JSON.stringify(body));
}

@Injectable()
class RequestBoundary implements NestMiddleware {
  constructor(@Inject(AUTHORIZE) private readonly authorized: Authorize) {}

  use(request: Request, response: Response, next: NextFunction) {
    if (request.headers.origin) return send(response, 403, { error: 'origin_not_allowed' });
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0'))
      return send(response, 400, { error: 'body_not_allowed' });
    if (request.url === '/healthz') return next();
    if (!this.authorized(request.headers.authorization))
      return send(response, 401, { error: 'unauthorized' });
    // Gate the raw URL so Express cannot introduce case, query, or slash aliases.
    if (request.url !== '/v1/runner') return send(response, 404, { error: 'not_found' });
    return next();
  }
}

@Controller()
class RunnerController {
  constructor(@Inject(DESCRIPTOR) private readonly descriptor: RunnerDescriptor) {}

  @Get('healthz')
  health(@Res() response: Response) {
    send(response, 200, { status: 'ok' });
  }

  @Get('v1/runner')
  runner(@Res() response: Response) {
    send(response, 200, this.descriptor);
  }
}

@Module({})
class RunnerModule {}

class RunnerHttpAdapter extends ExpressAdapter {
  override initHttpServer() {
    const server = createServer({ maxHeaderSize: 8192 }, this.getInstance());
    server.maxConnections = 64;
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.setTimeout(10_000, socket => socket.destroy());
    this.httpServer = server;
  }
}

export async function createRunnerApplication(
  descriptor: RunnerDescriptor,
  authorized: Authorize,
): Promise<INestApplication> {
  const adapter = new RunnerHttpAdapter();
  adapter.getInstance().disable('x-powered-by');
  const app = await NestFactory.create({
    module: RunnerModule,
    controllers: [RunnerController],
    providers: [
      RequestBoundary,
      { provide: DESCRIPTOR, useValue: descriptor },
      { provide: AUTHORIZE, useValue: authorized },
    ],
  }, adapter, { bodyParser: false, logger: false, abortOnError: false });
  const boundary = app.get(RequestBoundary);
  app.use(boundary.use.bind(boundary));
  await app.init();
  return app;
}
