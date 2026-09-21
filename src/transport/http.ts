import type { ServerResponse } from 'node:http';
import type { Request } from 'express';
import { LIMITS, RunnerError, type ErrorCode } from '../domain/contracts.js';

export function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  response.end(JSON.stringify(body));
}

const statusCodes: Record<ErrorCode, number> = {
  delivery_uncertain: 409, invalid_input: 400, not_found: 404, conflict: 409, quota_exceeded: 429,
  unsupported_media: 415, too_large: 413, busy: 503, storage_unavailable: 503,
};

export async function handle(response: ServerResponse, action: () => Promise<void>) {
  try { await action(); }
  catch (error) {
    if (response.destroyed || response.headersSent) return;
    if (error instanceof RunnerError) return send(response, statusCodes[error.code], { error: error.code });
    send(response, 500, { error: 'internal_error' });
  }
}

const CLIENT_CAPABILITY_BYTES = 512;
const CLIENT_CAPABILITIES = 16;

/** Unannounced clients get the oldest contract; an oversized or non-ASCII header announces nothing. */
export function clientCapabilities(header: string | string[] | undefined): ReadonlySet<string> {
  if (typeof header !== 'string' || header.length > CLIENT_CAPABILITY_BYTES || /[^\x20-\x7e]/.test(header)) return new Set();
  const tokens = header.split(',').map(token => token.trim());
  // Never announce a truncated subset: a client over the budget is treated as silent.
  if (tokens.length > CLIENT_CAPABILITIES) return new Set();
  return new Set(tokens.filter(token => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(token)));
}

export function cursor(request: Request): number {
  const separator = request.url.indexOf('?after=');
  if (separator === -1) return 0;
  const value = request.url.slice(separator + '?after='.length);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new RunnerError('invalid_input');
  return Number(value);
}

export async function jsonBody(request: Request, maximumBytes: number = LIMITS.jsonBytes): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
    throw new RunnerError('unsupported_media');
  if (request.headers['content-encoding']) throw new RunnerError('unsupported_media');
  if (Number(request.headers['content-length'] ?? 0) > maximumBytes)
    throw new RunnerError('too_large');
  const chunks: Buffer[] = [];
  let length = 0;
  // destroyOnReturn=false allows a bounded error response without draining an oversized body.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maximumBytes) throw new RunnerError('too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new RunnerError('invalid_input'); }
}
