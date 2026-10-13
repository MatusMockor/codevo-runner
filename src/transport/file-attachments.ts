import type { ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import type { AttachmentStore } from '../application/ports.js';
import { LIMITS, RunnerError } from '../domain/contracts.js';
import { fileContentDisposition, isFileMediaType } from '../domain/file-attachment.js';
import { send } from './http.js';
import { extendRequestDeadline } from './request-deadlines.js';

export function fileName(request: Request): string {
  const value = request.headers['x-file-name'];
  if (typeof value !== 'string' || !value.length) throw new RunnerError('invalid_input');
  try { return decodeURIComponent(value); }
  catch { throw new RunnerError('invalid_input'); }
}

export async function uploadFileAttachment(store: AttachmentStore, id: string, request: Request, response: Response): Promise<void> {
  const mediaType = request.headers['content-type'];
  if (request.headers['content-encoding'] !== undefined || !isFileMediaType(mediaType)) throw new RunnerError('unsupported_media');
  if (Number(request.headers['content-length'] ?? 0) > LIMITS.fileAttachmentBytes) throw new RunnerError('too_large');
  const name = fileName(request);
  const controller = new AbortController();
  const aborted = () => controller.abort();
  request.once('aborted', aborted);
  response.once('close', aborted);
  const release = extendRequestDeadline(request);
  try {
    const result = await store.uploadFile(id, name, mediaType, request.iterator({ destroyOnReturn: false }), controller.signal);
    if (!response.destroyed && !response.headersSent) send(response, result.created ? 201 : 200, result);
  } catch (error) {
    if (!(error instanceof RunnerError) || error.code !== 'request_timeout') throw error;
    if (!response.destroyed && !response.headersSent) send(response, 408, { error: 'request_timeout' });
    request.destroy();
  } finally {
    release();
    request.off('aborted', aborted);
    response.off('close', aborted);
  }
}

function settled(response: ServerResponse, event: 'drain' | 'finish'): Promise<void> {
  if (response.destroyed || response.writableFinished) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      response.off(event, done);
      response.off('close', done);
      resolve();
    };
    response.once(event, done);
    response.once('close', done);
  });
}

export async function sendFileAttachment(store: AttachmentStore, id: string, response: ServerResponse): Promise<void> {
  const content = await store.open(id);
  const chunks = content.chunks()[Symbol.asyncIterator]();
  try {
    let next = await chunks.next();
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': content.attachment.bytes,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': fileContentDisposition(content.attachment.name),
      connection: 'close',
    });
    try {
      while (!next.done) {
        if (response.destroyed) return;
        if (!response.write(next.value)) await settled(response, 'drain');
        next = await chunks.next();
      }
      if (response.destroyed) return;
      response.end();
      await settled(response, 'finish');
    } catch {
      response.destroy();
    }
  } finally {
    await chunks.return?.().catch(() => undefined);
    await content.close();
  }
}
