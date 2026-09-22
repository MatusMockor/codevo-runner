import { TurnChangesController } from './transport/turn-changes-controller.js';
import { RepositoryLookupController } from './transport/repository-lookup-controller.js';
import { ThreadMetadataController } from './transport/thread-metadata-controller.js';
import { ProjectDirectoriesController } from './transport/project-directories-controller.js';
import { TerminalController } from './transport/terminal-controller.js';
import { SurfaceController } from './transport/surface-controller.js';
import { QuestionController } from './transport/question-controller.js';
import { ArtifactController } from './transport/artifact-controller.js';
import { HistorySearchController } from './history-search-controller.js';
import { RunnerChangeTransport } from './transport/changes.js';
import 'reflect-metadata';
import { createServer } from 'node:http';
import {
  Controller, Get, Inject, Module, Req, Res,
  type INestApplication, type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { RequestBoundary } from './transport/boundary.js';
import { AttachmentController, ProjectController, ProjectCloneController, TaskController } from './transport/controllers.js';
import { clientCapabilities, send } from './transport/http.js';
import { AUTHORIZE, DESCRIPTOR, EXTENDED, SERVICES, type Authorize, type RunnerServices } from './transport/services.js';

export type RunnerDescriptor = Readonly<{
  protocolVersion: 1;
  executionTimeoutMs?: number;
  runnerId: string;
  name: string;
  capabilities: Readonly<{
    turnChanges?: boolean;
    projectManagement?: boolean;
    threadManagement?: boolean;
    interactiveQuestions?: boolean;
    instructionSync?: boolean;
    taskIsolation?: boolean;
    taskExecution: boolean;
    outputArtifacts?: boolean;
    taskContinuation?: boolean;
    pendingMessages?: boolean;
    taskSteering?: boolean;
    subagentTelemetry?: boolean;
    subagentLifecycleRetention?: boolean;
    taskFileDiffs?: boolean;
    taskLaunchOptions?: boolean;
    eventReplay: boolean;
    changeNotifications?: boolean;
    taskDrafts?: boolean;
    projectCloning?: boolean;
    imageAttachments?: boolean;
    textAttachments?: boolean;
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
  runner(@Req() request: Request, @Res() response: Response) {
    // Older editors validate discovery strictly. New optional features are announced
    // only to clients which explicitly understand the same feature contract.
    const supported = clientCapabilities(request.headers['x-codevo-client-capabilities']);
    const { turnChanges, projectManagement, threadManagement, ...legacy } = this.descriptor.capabilities;
    send(response, 200, { ...this.descriptor, capabilities: {
      ...legacy,
      ...(supported.has('turnChanges') && turnChanges !== undefined ? { turnChanges } : {}),
      ...(supported.has('projectManagement') && projectManagement !== undefined ? { projectManagement } : {}),
      ...(supported.has('threadManagement') && threadManagement !== undefined ? { threadManagement } : {}),
    } });
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
    capabilities: { turnChanges: Boolean(services.execution?.turnSummary && services.execution?.turnFileDiff), projectManagement: Boolean(services.repositories && services.projectDirectories && services.clones), threadManagement: Boolean(services.threadMetadata), taskIsolation: Boolean(services.execution), interactiveQuestions: Boolean(services.questions), instructionSync: process.platform === 'linux' && Boolean(services.execution), outputArtifacts: Boolean(services.artifacts), pendingMessages: Boolean(services.execution), taskSteering: Boolean(services.execution), subagentTelemetry: Boolean(services.execution), taskFileDiffs: Boolean(services.execution), taskLaunchOptions: Boolean(services.execution), taskContinuation: Boolean(services.execution), taskExecution: Boolean(services.execution), eventReplay: true, subagentLifecycleRetention: true, taskDrafts: true, imageAttachments: true, textAttachments: true, projectCloning: Boolean(services.clones) },
  } : { ...descriptor, capabilities: { ...descriptor.capabilities, turnChanges: false, projectManagement: false, threadManagement: false } };
  const changes = services?.changes ? new RunnerChangeTransport(services.changes, descriptor.runnerId, authorized) : undefined;
  const app = await NestFactory.create({
    module: RunnerModule,
    controllers: [RunnerController, ...(services ? [TurnChangesController, RepositoryLookupController, ThreadMetadataController, ProjectDirectoriesController, TerminalController, SurfaceController, QuestionController, ArtifactController, TaskController, AttachmentController, ProjectController, ProjectCloneController, HistorySearchController] : [])],
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
