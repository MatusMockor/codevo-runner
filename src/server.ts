import { createServer, type ServerResponse } from 'node:http';

export type RunnerDescriptor = Readonly<{
  protocolVersion: 1;
  runnerId: string;
  name: string;
  capabilities: Readonly<{ taskExecution: false; eventReplay: false }>;
}>;

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'connection': 'close',
  });
  response.end(JSON.stringify(body));
}

export function createRunnerServer(
  descriptor: RunnerDescriptor,
  authorized: (header: string | undefined) => boolean,
) {
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (request.headers.origin) return send(response, 403, { error: 'origin_not_allowed' });
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0'))
      return send(response, 400, { error: 'body_not_allowed' });
    if (request.url === '/healthz') return send(response, 200, { status: 'ok' });
    if (!authorized(request.headers.authorization))
      return send(response, 401, { error: 'unauthorized' });
    if (request.url === '/v1/runner') return send(response, 200, descriptor);
    return send(response, 404, { error: 'not_found' });
  });
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.setTimeout(10_000, socket => socket.destroy());
  return server;
}
