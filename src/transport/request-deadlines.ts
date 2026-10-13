import { STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { LIMITS } from '../domain/contracts.js';

const SOCKET_SLACK_MS = 5_000;
const extended = new WeakSet<Socket>();
const inFlight = new WeakMap<Socket, ServerResponse>();

function status(code: string | undefined): number {
  switch (code) {
    case 'HPE_HEADER_OVERFLOW': return 431;
    case 'HPE_CHUNK_EXTENSIONS_OVERFLOW': return 413;
    case 'ERR_HTTP_REQUEST_TIMEOUT': return 408;
    default: return 400;
  }
}

function rejectClient(error: NodeJS.ErrnoException, socket: Socket): void {
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT' && extended.has(socket)) return;
  const response = inFlight.get(socket);
  if (socket.writable && (!response || response.writableFinished || !response.headersSent)) {
    const code = status(error.code);
    socket.write(Buffer.from(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`, 'latin1'));
  }
  socket.destroy(error);
}

export function guardRequestDeadlines(server: Server): void {
  server.on('request', (request, response) => { inFlight.set(request.socket, response); });
  server.on('clientError', rejectClient);
}

export function extendRequestDeadline(request: IncomingMessage): () => void {
  const { socket } = request;
  const previous = socket.timeout ?? 0;
  extended.add(socket);
  socket.setTimeout(LIMITS.fileUploadIdleTimeoutMs + SOCKET_SLACK_MS);
  return () => {
    extended.delete(socket);
    if (!socket.destroyed) socket.setTimeout(previous);
  };
}
