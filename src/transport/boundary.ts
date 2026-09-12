import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AUTHORIZE, EXTENDED, type Authorize } from './services.js';
import { send } from './http.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const startRoute = new RegExp(`^/v1/tasks/${uuid}/start$`);
const routes = [
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
  ) {}

  use(request: Request, response: Response, next: NextFunction) {
    if (request.headers.origin !== undefined) return send(response, 403, { error: 'origin_not_allowed' });
    if (!this.extended || request.url === '/healthz' || request.url === '/v1/runner')
      return this.discovery(request, response, next);
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' });
    const route = routes.find(candidate => candidate.pattern.test(request.url));
    if (!route) return send(response, 404, { error: 'not_found' });
    if (!route.methods.includes(request.method)) return send(response, 405, { error: 'method_not_allowed' });
    if (request.method === 'POST' && request.url.startsWith('/v1/tasks?'))
      return send(response, 404, { error: 'not_found' });
    const acceptsBody = request.method === 'PUT' || (request.method === 'POST' &&
      (request.url === '/v1/tasks' || startRoute.test(request.url)));
    if (!acceptsBody && hasBody(request)) return send(response, 400, { error: 'body_not_allowed' });
    return next();
  }

  private discovery(request: Request, response: Response, next: NextFunction) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (hasBody(request)) return send(response, 400, { error: 'body_not_allowed' });
    if (request.url === '/healthz') return next();
    if (!this.authorized(request.headers.authorization)) return send(response, 401, { error: 'unauthorized' });
    if (request.url !== '/v1/runner') return send(response, 404, { error: 'not_found' });
    return next();
  }
}
