import { SpeechController } from './transport/speech-controller.js';
import { AccountUsageController } from './transport/account-usage-controller.js';
import { CommandCatalogController } from './transport/command-catalog-controller.js';
import { TurnChangesController } from './transport/turn-changes-controller.js';
import { GitSyncController } from './transport/git-sync-controller.js';
import { PortPreviewController } from './transport/port-preview-controller.js';
import { RepositoryLookupController } from './transport/repository-lookup-controller.js';
import { ThreadMetadataController } from './transport/thread-metadata-controller.js';
import { ProjectDirectoriesController } from './transport/project-directories-controller.js';
import { TerminalController } from './transport/terminal-controller.js';
import { SurfaceController } from './transport/surface-controller.js';
import { QuestionController } from './transport/question-controller.js';
import { ApprovalController } from './transport/approval-controller.js';
import { INTERACTIVE_APPROVALS } from './domain/approvals.js';
import { ArtifactController } from './transport/artifact-controller.js';
import { HistorySearchController } from './history-search-controller.js';
import { RunnerChangeTransport } from './transport/changes.js';
import 'reflect-metadata';
import { createServer } from 'node:http';
import {
  Controller, Get, Inject, Module, Req, Res,
  type BeforeApplicationShutdown, type INestApplication, type OnApplicationShutdown,
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
    speechTranscription?: boolean;
    accountUsage?: boolean;
    commandCatalog?: boolean;
    turnChanges?: boolean;
    gitSync?: boolean;
    portPreview?: boolean;
    projectManagement?: boolean;
    threadManagement?: boolean;
    interactiveQuestions?: boolean;
    interactiveApprovals?: boolean;
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
    const { speechTranscription, accountUsage, commandCatalog, turnChanges, gitSync, portPreview, projectManagement, threadManagement, interactiveApprovals, ...legacy } = this.descriptor.capabilities;
    send(response, 200, { ...this.descriptor, capabilities: {
      ...legacy,
      ...(supported.has('speechTranscription') && speechTranscription !== undefined ? { speechTranscription } : {}),
      ...(supported.has('accountUsage') && accountUsage !== undefined ? { accountUsage } : {}),
      ...(supported.has('commandCatalog') && commandCatalog !== undefined ? { commandCatalog } : {}),
      ...(supported.has('turnChanges') && turnChanges !== undefined ? { turnChanges } : {}),
      ...(supported.has('gitSync') && gitSync !== undefined ? { gitSync } : {}),
      ...(supported.has('portPreview') && portPreview !== undefined ? { portPreview } : {}),
      ...(supported.has('projectManagement') && projectManagement !== undefined ? { projectManagement } : {}),
      ...(supported.has('threadManagement') && threadManagement !== undefined ? { threadManagement } : {}),
      ...(supported.has(INTERACTIVE_APPROVALS) && interactiveApprovals !== undefined ? { interactiveApprovals } : {}),
    } });
  }
}

class ServiceLifecycle implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}
  async beforeApplicationShutdown() {
    const speechClosing = this.services.speech?.close();
    await this.services.execution?.close().catch(() => undefined);
    await speechClosing;
  }
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
    capabilities: { speechTranscription: Boolean(services.speech), accountUsage: Boolean(services.accountUsage), commandCatalog: Boolean(services.commandCatalog), turnChanges: Boolean(services.execution?.turnSummary && services.execution?.turnFileDiff), gitSync: Boolean(services.execution && services.gitSync), portPreview: process.platform === 'linux' && Boolean(services.execution && services.ports), projectManagement: Boolean(services.repositories && services.projectDirectories && services.clones), threadManagement: Boolean(services.threadMetadata), taskIsolation: Boolean(services.execution), interactiveQuestions: Boolean(services.questions), interactiveApprovals: Boolean(services.approvals), instructionSync: process.platform === 'linux' && Boolean(services.execution), outputArtifacts: Boolean(services.artifacts), pendingMessages: Boolean(services.execution), taskSteering: Boolean(services.execution), subagentTelemetry: Boolean(services.execution), taskFileDiffs: Boolean(services.execution), taskLaunchOptions: Boolean(services.execution), taskContinuation: Boolean(services.execution), taskExecution: Boolean(services.execution), eventReplay: true, subagentLifecycleRetention: true, taskDrafts: true, imageAttachments: true, textAttachments: true, projectCloning: Boolean(services.clones) },
  } : { ...descriptor, capabilities: { ...descriptor.capabilities, speechTranscription: false, accountUsage: false, commandCatalog: false, turnChanges: false, gitSync: false, portPreview: false, projectManagement: false, threadManagement: false, interactiveApprovals: false } };
  const changes = services?.changes ? new RunnerChangeTransport(services.changes, descriptor.runnerId, authorized) : undefined;
  const app = await NestFactory.create({
    module: RunnerModule,
    controllers: [RunnerController, ...(services ? [SpeechController, AccountUsageController, CommandCatalogController, TurnChangesController, GitSyncController, PortPreviewController, RepositoryLookupController, ThreadMetadataController, ProjectDirectoriesController, TerminalController, SurfaceController, QuestionController, ApprovalController, ArtifactController, TaskController, AttachmentController, ProjectController, ProjectCloneController, HistorySearchController] : [])],
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
