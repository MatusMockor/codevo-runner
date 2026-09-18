import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AUTHORIZE, DESCRIPTOR, EXTENDED, type Authorize } from './services.js';
import { send } from './http.js';
import type { RunnerDescriptor } from '../server.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const startRoute = new RegExp(`^/v1/tasks/${uuid}/start$`);
const continueRoute = new RegExp(`^/v1/tasks/${uuid}/continue$`);
const steerRoute = new RegExp(`^/v1/tasks/${uuid}/steer$`);
const pendingSteerRoute = new RegExp(`^/v1/tasks/${uuid}/pending/${uuid}/steer$`);
const pendingRoute = new RegExp(`^/v1/tasks/${uuid}/pending$`);
const fileDiffRoute = new RegExp(`^/v1/tasks/${uuid}/file-diff$`);
const artifactRoute = new RegExp(`^/v1/tasks/${uuid}/artifacts$`);
const answerRoute = new RegExp(`^/v1/tasks/${uuid}/questions/${uuid}/answer$`);
const surfaceRoute = /^\/v1\/projects\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/surface\/(tree|read|write|history|commit-files|commit-diff)$/;
const terminalBase = '/v1/projects/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}/terminals';
const terminalOpenRoute = new RegExp(`^${terminalBase}$`);
const terminalActionRoute = new RegExp(`^${terminalBase}/${uuid}/(input|resize)(?:\\?taskId=${uuid})?$`);
const routes = [
  { pattern: /^\/v1\/projects\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/surface\/capabilities$/, methods: ['GET'] },
  { pattern: terminalOpenRoute, methods: ['POST'] },
  { pattern: terminalActionRoute, methods: ['POST'] },
  { pattern: new RegExp(`^${terminalBase}/${uuid}(?:\\?(?:after=[0-9]+(?:&taskId=${uuid})?|taskId=${uuid}(?:&after=[0-9]+)?))?$`), methods: ['GET'] },
  { pattern: new RegExp(`^${terminalBase}/${uuid}(?:\\?taskId=${uuid})?$`), methods: ['DELETE'] },
  { pattern: surfaceRoute, methods: ['POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/questions$`), methods: ['GET'] },
  { pattern: answerRoute, methods: ['POST'] },
  { pattern: artifactRoute, methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/artifacts/${uuid}/content$`), methods: ['GET'] },
  { pattern: steerRoute, methods: ['POST'] },
  { pattern: pendingSteerRoute, methods: ['POST'] },
  { pattern: pendingRoute, methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/pending/resume$`), methods: ['POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/pending/${uuid}$`), methods: ['DELETE'] },
  { pattern: /^\/v1\/history\/search(?:\?[^#]*)?$/, methods: ['GET'] },
  { pattern: fileDiffRoute, methods: ['POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/files$`), methods: ['GET'] },
  { pattern: continueRoute, methods: ['POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/resume$`), methods: ['GET'] },
  { pattern: /^\/v1\/projects\/clone$/, methods: ['POST'] },
  { pattern: new RegExp(`^/v1/project-clones/${uuid}$`), methods: ['GET'] },
  { pattern: new RegExp(`^/v1/project-clones/${uuid}/cancel$`), methods: ['POST'] },
  { pattern: /^\/v1\/tasks(?:\?after=[^&?#]*)?$/, methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}$`), methods: ['GET'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/cancel$`), methods: ['POST'] },
  { pattern: startRoute, methods: ['POST'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/diff$`), methods: ['GET'] },
  { pattern: /^\/v1\/projects$/, methods: ['GET'] },
  { pattern: new RegExp(`^/v1/tasks/${uuid}/events(?:\\?after=[^&?#]*)?$`), methods: ['GET'] },
  { pattern: new RegExp(`^/v1/attachments/${uuid}$`), methods: ['GET', 'PUT'] },
  { pattern: new RegExp(`^/v1/attachments/${uuid}/content$`), methods: ['GET'] },
];

function hasBody(request: Request) {
  return request.headers['transfer-encoding'] ||
    (request.headers['content-length'] && request.headers['content-length'] !== '0');
}

@Injectable()
export class RequestBoundary implements NestMiddleware {
  constructor(
    @Inject(AUTHORIZE) private readonly authorized: Authorize,
    @Inject(EXTENDED) private readonly extended: boolean,
    @Inject(DESCRIPTOR) private readonly descriptor: RunnerDescriptor,
  ) {}

  use(request: Request, response: Response, next: NextFunction) {
    if (request.headers.origin !== undefined) return send(response, 403, { error: 'origin_not_allowed' });
    if (!this.extended || request.url === '/healthz' || request.url === '/v1/runner')
      return this.discovery(request, response, next);
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' });
    if (!this.matchesIdentity(request, response)) return;
    const matching = routes.filter(candidate => candidate.pattern.test(request.url));
    const route = matching.find(candidate => candidate.methods.includes(request.method)) ?? matching[0];
    if (!route) return send(response, 404, { error: 'not_found' });
    if (!route.methods.includes(request.method)) return send(response, 405, { error: 'method_not_allowed' });
    if (request.method === 'POST' && request.url.startsWith('/v1/tasks?'))
      return send(response, 404, { error: 'not_found' });
    const acceptsBody = request.method === 'PUT' || (request.method === 'POST' &&
      (terminalOpenRoute.test(request.url) || terminalActionRoute.test(request.url) || surfaceRoute.test(request.url) || request.url === '/v1/tasks' || request.url === '/v1/projects/clone' || startRoute.test(request.url) || continueRoute.test(request.url) || steerRoute.test(request.url) || pendingRoute.test(request.url) || fileDiffRoute.test(request.url) || artifactRoute.test(request.url) || answerRoute.test(request.url)));
    if (!acceptsBody && hasBody(request)) return send(response, 400, { error: 'body_not_allowed' });
    return next();
  }

  private matchesIdentity(request: Request, response: Response): boolean {
    if (!request.url.startsWith('/v1/')) return true;
    const occurrences = request.rawHeaders.filter((value, index) =>
      index % 2 === 0 && value.toLowerCase() === 'x-codevo-runner-id').length;
    if (occurrences > 1) {
      send(response, 400, { error: 'duplicate_runner_identity' });
      return false;
    }
    const expected = request.headers['x-codevo-runner-id'];
    if (expected !== undefined && expected !== this.descriptor.runnerId) {
      send(response, 409, { error: 'runner_identity_mismatch' });
      return false;
    }
    return true;
  }

  private discovery(request: Request, response: Response, next: NextFunction) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (hasBody(request)) return send(response, 400, { error: 'body_not_allowed' });
    if (request.url === '/healthz') return next();
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' });
    if (!this.matchesIdentity(request, response)) return;
    if (request.url !== '/v1/runner') return send(response, 404, { error: 'not_found' });
    return next();
  }
}
