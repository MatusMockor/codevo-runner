import { HistorySearchController } from './history-search-controller.js';
import { RunnerChangeTransport } from './transport/changes.js';
import 'reflect-metadata';
import { createServer } from 'node:http';
import {
  Controller, Get, Inject, Module, Res,
  type INestApplication, type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RequestBoundary } from './transport/boundary.js';
import { AttachmentController, ProjectController, ProjectCloneController, TaskController } from './transport/controllers.js';
import { send } from './transport/http.js';
import { AUTHORIZE, DESCRIPTOR, EXTENDED, SERVICES, type Authorize, type RunnerServices } from './transport/services.js';

export type RunnerDescriptor = Readonly<{
  protocolVersion: 1;
  runnerId: string;
  name: string;
  capabilities: Readonly<{
    taskExecution: boolean;
    taskContinuation?: boolean;
    pendingMessages?: boolean;
    taskFileDiffs?: boolean;
    taskLaunchOptions?: boolean;
    eventReplay: boolean;
    changeNotifications?: boolean;
    taskDrafts?: boolean;
    projectCloning?: boolean;
    imageAttachments?: boolean;
  }>;
}>;
export type { RunnerServices } from './transport/services.js';

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

class ServiceLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  async onApplicationShutdown() { await this.services.close(); }
}

@Module({})
class RunnerModule {}

class RunnerHttpAdapter extends ExpressAdapter {
  override initHttpServer() {
    const server = createServer({ maxHeaderSize: 8192 }, this.getInstance());
    server.maxConnections = 64;
    server.requestTimeout = 35_000;
    server.headersTimeout = 5_000;
    server.setTimeout(35_000, socket => socket.destroy());
    this.httpServer = server;
  }
}

export async function createRunnerApplication(
  descriptor: RunnerDescriptor,
  authorized: Authorize,
  services?: RunnerServices,
): Promise<INestApplication> {
  const adapter = new RunnerHttpAdapter();
  adapter.getInstance().disable('x-powered-by');
  const effectiveDescriptor: RunnerDescriptor = services ? {
    ...descriptor,
    capabilities: { pendingMessages: Boolean(services.execution), taskFileDiffs: Boolean(services.execution), taskLaunchOptions: Boolean(services.execution), taskContinuation: Boolean(services.execution), taskExecution: Boolean(services.execution), eventReplay: true, taskDrafts: true, imageAttachments: true, projectCloning: Boolean(services.clones) },
  } : descriptor;
  const changes = services?.changes ? new RunnerChangeTransport(services.changes, descriptor.runnerId, authorized) : undefined;
  const app = await NestFactory.create({
    module: RunnerModule,
    controllers: [RunnerController, ...(services ? [TaskController, AttachmentController, ProjectController, ProjectCloneController, HistorySearchController] : [])],
    providers: [
      RequestBoundary,
      ...(changes ? [{ provide: RunnerChangeTransport, useValue: changes }] : []),
      { provide: DESCRIPTOR, useValue: effectiveDescriptor },
      { provide: AUTHORIZE, useValue: authorized },
      { provide: EXTENDED, useValue: Boolean(services) },
      ...(services ? [{ provide: SERVICES, useValue: services }, ServiceLifecycle] : []),
    ],
  }, adapter, { bodyParser: false, logger: false, abortOnError: false });
  const boundary = app.get(RequestBoundary);
  app.use(boundary.use.bind(boundary));
  await app.init();
  changes?.attach(app.getHttpServer());
  return app;
}
