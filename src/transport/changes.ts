import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RunnerChangeSource } from '../application/runner-changes.js';
import type { Authorize } from './services.js';

/** Owned, bounded invalidation stream. Task payloads stay in cursor-based HTTP APIs. */
export class RunnerChangeTransport {
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 256, perMessageDeflate: false });
  private readonly alive = new Set<WebSocket>();
  private server?: Server;
  private unsubscribe?: () => void;
  private pending?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly source: RunnerChangeSource, private readonly runnerId: string,
    private readonly authorized: Authorize) {}

  attach(server: Server): void {
    this.server = server;
    this.unsubscribe = this.source.subscribe(() => {
      this.pending ??= setTimeout(() => {
        this.pending = undefined;
        for (const client of this.websocket.clients) this.send(client, 'changed');
      }, 100).unref();
    });
    server.on('upgrade', this.upgrade);
    this.heartbeat = setInterval(() => {
      for (const client of this.websocket.clients) {
        if (!this.alive.delete(client)) { client.terminate(); continue; }
        client.ping();
      }
    }, 15_000).unref();
  }

  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (this.closed) return reject(503);
    if (request.url !== '/v1/changes') return reject(404);
    if (request.method !== 'GET' || request.headers.origin !== undefined ||
      request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) return reject(400);
    const occurrences = (name: string) => request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length;
    if (occurrences('authorization') !== 1 || !this.authorized(request.headers.authorization)) return reject(401);
    if (occurrences('x-codevo-runner-id') !== 1 || request.headers['x-codevo-runner-id'] !== this.runnerId) return reject(409);
    if (this.websocket.clients.size >= 16) return reject(503);
    this.websocket.handleUpgrade(request, socket, head, client => {
      // The HTTP idle timeout must not destroy a healthy long-lived stream.
      request.socket.setTimeout(0);
      this.alive.add(client);
      client.on('pong', () => this.alive.add(client));
      client.on('message', () => client.terminate());
      client.on('error', () => client.terminate());
      client.on('close', () => this.alive.delete(client));
      this.send(client, 'snapshot');
    });
  };

  private send(client: WebSocket, type: 'snapshot' | 'changed'): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 16_384) { client.terminate(); return; }
    client.send(JSON.stringify({ type, runnerId: this.runnerId, ...this.source.snapshot() }), error => {
      if (error) client.terminate();
    });
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.server?.off('upgrade', this.upgrade);
    this.unsubscribe?.();
    clearTimeout(this.pending);
    clearInterval(this.heartbeat);
    for (const client of this.websocket.clients) client.terminate();
    this.alive.clear();
    this.websocket.close();
  }
}
