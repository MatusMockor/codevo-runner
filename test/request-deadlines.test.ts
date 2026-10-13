import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LIMITS } from '../src/domain/contracts.js';
import { extendRequestDeadline, guardRequestDeadlines } from '../src/transport/request-deadlines.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function start(t: TestContext, guarded: boolean, handler: Handler) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 300, headersTimeout: 200, connectionsCheckingInterval: 25 }, handler);
  if (guarded) guardRequestDeadlines(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

function exchange(port: number, steps: ReadonlyArray<string | number>): Promise<string> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', chunk => { received.push(chunk); });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(Buffer.concat(received).toString('latin1')));
    socket.setTimeout(10_000, () => { socket.destroy(); });
    socket.once('connect', () => {
      void (async () => {
        for (const step of steps) {
          if (typeof step === 'number') await delay(step);
          if (typeof step === 'string' && !socket.destroyed) socket.write(step, 'latin1');
        }
      })();
    });
  });
}

const drain: Handler = (request, response) => {
  let bytes = 0;
  request.on('data', chunk => { bytes += chunk.length; });
  request.on('end', () => { response.writeHead(200, { connection: 'close', 'content-length': String(bytes).length }); response.end(String(bytes)); });
};
const slowBody = ['PUT /upload HTTP/1.1\r\nHost: runner\r\nContent-Length: 6\r\n\r\nabc', 700, 'def'];

test('the guarded server answers malformed, oversized and late requests exactly like an unguarded one', async t => {
  const plain = await start(t, false, drain);
  const guarded = await start(t, true, drain);
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string | number>, RegExp]> = [
    ['header overflow', [`GET / HTTP/1.1\r\nHost: runner\r\nX-Large: ${'a'.repeat(9000)}\r\n\r\n`], /^HTTP\/1\.1 431 /],
    ['malformed request line', ['NOT A REQUEST\r\n\r\n'], /^HTTP\/1\.1 400 /],
    ['stalled headers', ['GET / HTTP/1.1\r\nHost: runner\r\n', 600], /^HTTP\/1\.1 408 /],
    ['stalled body', slowBody, /^HTTP\/1\.1 408 /],
  ];
  for (const [name, steps, status] of cases) {
    const expected = await exchange(plain, steps);
    const actual = await exchange(guarded, steps);
    assert.match(expected, status, name);
    assert.equal(actual, expected, name);
    assert.ok(actual.endsWith('Connection: close\r\n\r\n'), name);
  }
  const completed = await exchange(guarded, ['PUT /upload HTTP/1.1\r\nHost: runner\r\nContent-Length: 6\r\n\r\nabcdef']);
  assert.match(completed, /^HTTP\/1\.1 200 /);
  assert.ok(completed.endsWith('\r\n\r\n6'));
});

test('an extended request outlives the server request deadline and restores the socket timeout afterwards', async t => {
  const timeouts: Array<number | undefined> = [];
  const port = await start(t, true, (request, response) => {
    if (request.url !== '/upload') { drain(request, response); return; }
    request.socket.setTimeout(35_000);
    const release = extendRequestDeadline(request);
    timeouts.push(request.socket.timeout);
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; });
    request.on('end', () => {
      release();
      timeouts.push(request.socket.timeout);
      response.writeHead(200, { connection: 'close', 'content-length': String(bytes).length });
      response.end(String(bytes));
    });
  });
  const extended = await exchange(port, slowBody);
  assert.match(extended, /^HTTP\/1\.1 200 /);
  assert.ok(extended.endsWith('\r\n\r\n6'));
  assert.deepEqual(timeouts, [LIMITS.fileUploadIdleTimeoutMs + 5_000, 35_000]);
  assert.match(await exchange(port, ['PUT /other HTTP/1.1\r\nHost: runner\r\nContent-Length: 6\r\n\r\nabc', 700, 'def']), /^HTTP\/1\.1 408 /);
});
