import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SpeechTranscriptionService } from '../src/application/speech-transcription-service.js';
import { readConfig } from '../src/config.js';
import { HttpSpeechTranscriber } from '../src/infrastructure/speech/http-transcriber.js';
import { openRunnerServices, type RunnerSpeechOptions } from '../src/runtime.js';
import { createRunnerApplication } from '../src/server.js';

type UpstreamCall = Readonly<{
  method: string | undefined; url: string | undefined; contentType: string | undefined;
  body: Buffer; response: ServerResponse; completed: Promise<boolean>;
}>;
type Reply = (call: UpstreamCall) => void;
type Outcome = Readonly<{ status: number; body: unknown }>;
type Runner = Awaited<ReturnType<typeof startRunner>>;

const unavailable: Outcome = { status: 503, body: { error: 'speech_unavailable' } };
const busy: Outcome = { status: 503, body: { error: 'busy' } };
const hold: Reply = () => undefined;
const pcm = (bytes: number, fill = 0) => Buffer.alloc(bytes, fill);

function json(call: UpstreamCall, status: number, value: unknown) {
  call.response.writeHead(status, { 'content-type': 'application/json' });
  call.response.end(JSON.stringify(value));
}
const transcript = (text: string): Reply => call => json(call, 200, { text });

async function startSidecar(t: TestContext, initial: Reply = hold) {
  const calls: UpstreamCall[] = [];
  const arrivals: Array<() => void> = [];
  const state = { reply: initial, active: 0, peak: 0 };
  const server = createServer((request, response) => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    const completed = new Promise<boolean>(resolve => response.once('close', () => {
      state.active -= 1;
      resolve(response.writableFinished);
    }));
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => {
      const call: UpstreamCall = {
        method: request.method, url: request.url, contentType: request.headers['content-type'],
        body: Buffer.concat(chunks), response, completed,
      };
      calls.push(call);
      for (const arrived of arrivals.splice(0)) arrived();
      state.reply(call);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const received = async (count: number): Promise<UpstreamCall> => {
    while (calls.length < count) await new Promise<void>(resolve => arrivals.push(resolve));
    return calls[count - 1]!;
  };
  const answer = (reply: Reply) => {
    state.reply = reply;
    for (const call of calls) if (!call.response.headersSent && !call.response.destroyed) reply(call);
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, state, received, answer };
}

async function startRunner(t: TestContext, speech?: RunnerSpeechOptions) {
  const root = await mkdtemp(join(tmpdir(), 'runner-speech-'));
  const runnerId = randomUUID();
  const services = await openRunnerServices(join(root, 'data'), runnerId, undefined, speech);
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: 'Speech',
    capabilities: { taskExecution: false, eventReplay: true } }, header => header === 'Bearer test', services);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= app.close();
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const headers: Record<string, string> = { authorization: 'Bearer test', 'x-codevo-runner-id': runnerId };
  return { root, base, headers, close, speech: services.speech, route: `${base}/v1/speech/transcriptions` };
}

async function read(response: Response): Promise<Outcome> {
  return { status: response.status, body: await response.json() };
}

function transcribe(runner: Runner, audio: Buffer, options: { language?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Outcome> {
  return fetch(`${runner.route}?language=${options.language ?? 'sk'}`, {
    method: 'POST', body: new Uint8Array(audio), signal: options.signal ?? null,
    headers: { ...runner.headers, 'content-type': 'application/octet-stream', ...options.headers },
  }).then(read);
}

function rawTranscribe(runner: Runner, headers: Record<string, string>, write: (request: ClientRequest) => void): Promise<Outcome> {
  return new Promise<Outcome>((resolve, reject) => {
    const request = httpRequest(`${runner.route}?language=sk`, {
      method: 'POST', agent: false, headers: { ...runner.headers, 'content-type': 'application/octet-stream', ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    request.once('error', reject);
    write(request);
  });
}

function unchunked(payload: string): string {
  let text = '';
  let rest = payload;
  for (let size = Number.parseInt(rest, 16); size > 0; size = Number.parseInt(rest, 16)) {
    const start = rest.indexOf('\r\n') + 2;
    text += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2);
  }
  return text;
}

function uploadBeforeReading(runner: Runner, audio: Buffer, pieces: number, pauseMs: number): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${runner.route}?language=sk`);
    const socket = connect(Number(target.port), target.hostname);
    const received: Buffer[] = [];
    socket.pause();
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.once('end', () => {
      const text = Buffer.concat(received).toString('utf8');
      socket.destroy();
      const payload = text.slice(text.indexOf('\r\n\r\n') + 4);
      const chunked = /\r\ntransfer-encoding: chunked\r\n/i.test(text);
      resolve({ status: Number(text.slice('HTTP/1.1 '.length, 'HTTP/1.1 '.length + 3)), body: chunked ? unchunked(payload) : payload });
    });
    const head = [`POST ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`,
      ...Object.entries(runner.headers).map(([name, value]) => `${name}: ${value}`),
      'content-type: application/octet-stream', `content-length: ${audio.length}`, '', ''];
    socket.write(head.join('\r\n'));
    const size = audio.length / pieces;
    const send = (index: number): void => {
      if (index === pieces) return void socket.resume();
      socket.write(audio.subarray(index * size, (index + 1) * size), () => setTimeout(send, pauseMs, index + 1));
    };
    send(0);
  });
}

function settled(outcomes: readonly Promise<unknown>[], count: number): Promise<void> {
  return new Promise<void>(resolve => {
    let done = 0;
    const record = () => {
      done += 1;
      if (done === count) resolve();
    };
    for (const outcome of outcomes) void outcome.then(record, record);
  });
}

async function unusedLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return url;
}

async function storedBytes(directory: string): Promise<Buffer> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => readFile(join(entry.parentPath, entry.name)));
  return Buffer.concat(await Promise.all(files));
}

test('speech URL configuration accepts only bare loopback HTTP origins', () => {
  const configured = (value: string) => readConfig({ CODEVO_TOKEN_FILE: 'token', CODEVO_SPEECH_URL: value }).speechUrl;
  assert.equal(readConfig({ CODEVO_TOKEN_FILE: 'token' }).speechUrl, undefined);
  const accepted = [
    ['http://127.0.0.1:8001', 'http://127.0.0.1:8001'], ['http://127.0.0.1:8001/', 'http://127.0.0.1:8001'],
    ['http://127.0.0.1', 'http://127.0.0.1'], ['http://127.255.0.9:65535', 'http://127.255.0.9:65535'],
    ['http://[::1]:8001', 'http://[::1]:8001'], ['http://[::1]/', 'http://[::1]'],
  ] as const;
  for (const [value, origin] of accepted) assert.equal(configured(value), origin);
  const rejected = [
    '', '127.0.0.1:8001', 'https://127.0.0.1:8001', 'HTTP://127.0.0.1:8001', 'ws://127.0.0.1:8001',
    'http://localhost:8001', 'http://128.0.0.1:8001', 'http://10.0.0.1:8001', 'http://0.0.0.0:8001',
    'http://127.0.0.256:8001', 'http://127.0.0.01:8001', 'http://127.1:8001', 'http://2130706433:8001',
    'http://0x7f.0.0.1:8001', 'http://127.0.0.1.example.com:8001', 'http://[::]:8001', 'http://[::2]:8001',
    'http://[::ffff:127.0.0.1]:8001', 'http://[fe80::1]:8001', 'http://::1:8001', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://127.0.0.1:', 'http://127.0.0.1:08001', 'http://127.0.0.1:8001/transcribe',
    'http://127.0.0.1:8001//', 'http://127.0.0.1:8001?language=sk', 'http://127.0.0.1:8001/?', 'http://127.0.0.1:8001#x',
    'http://127.0.0.1:8001/#', 'http://user@127.0.0.1:8001', 'http://user:secret@127.0.0.1:8001',
    'http://evil.example@127.0.0.1:8001', ' http://127.0.0.1:8001', 'http://127.0.0.1:8001 ', 'http://127.0.0.1:8001\n',
  ];
  for (const value of rejected) assert.throws(() => configured(value), /CODEVO_SPEECH_URL/, JSON.stringify(value));
});

test('speech capability is announced only to announcing clients and only when configured', async t => {
  const sidecar = await startSidecar(t, transcript('ok'));
  const absent = await startRunner(t);
  const present = await startRunner(t, { url: sidecar.url });
  const capabilities = async (runner: Runner, announced?: string) => {
    const headers = announced === undefined ? runner.headers : { ...runner.headers, 'x-codevo-client-capabilities': announced };
    const descriptor = await (await fetch(runner.base + '/v1/runner', { headers })).json() as { capabilities: Record<string, unknown> };
    return descriptor.capabilities;
  };
  const olderAbsent = await capabilities(absent);
  const olderPresent = await capabilities(present);
  assert.equal('speechTranscription' in olderAbsent, false);
  assert.deepEqual(olderPresent, olderAbsent);
  assert.equal('speechTranscription' in await capabilities(present, 'accountUsage,gitSync'), false);
  assert.equal('speechTranscription' in await capabilities(present, 'speechtranscription'), false);
  assert.equal((await capabilities(present, 'speechTranscription')).speechTranscription, true);
  assert.equal((await capabilities(present, 'accountUsage, speechTranscription')).speechTranscription, true);
  assert.equal((await capabilities(absent, 'speechTranscription')).speechTranscription, false);
  assert.deepEqual(await capabilities(present, 'speechTranscription'), { ...olderPresent, speechTranscription: true });
  assert.deepEqual(await transcribe(absent, pcm(640)), { status: 404, body: { error: 'not_found' } });
  assert.deepEqual(await transcribe(present, pcm(640)), { status: 200, body: { text: 'ok' } });
  assert.equal(sidecar.calls.length, 1);
});

test('speech route enforces authentication, runner identity, the exact query and the method', async t => {
  const sidecar = await startSidecar(t, transcript('ok'));
  const runner = await startRunner(t, { url: sidecar.url });
  const url = `${runner.route}?language=sk`;
  const body = new Uint8Array(pcm(640));
  const post = async (target: string, headers: Record<string, string>) =>
    read(await fetch(target, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } }));
  assert.equal((await post(url, { 'x-codevo-runner-id': runner.headers['x-codevo-runner-id']! })).status, 401);
  assert.deepEqual(await post(url, { authorization: 'Bearer test' }), { status: 409, body: { error: 'runner_identity_mismatch' } });
  assert.deepEqual(await post(url, { ...runner.headers, 'x-codevo-runner-id': randomUUID() }), { status: 409, body: { error: 'runner_identity_mismatch' } });
  assert.equal((await post(url, { ...runner.headers, origin: 'https://foreign.invalid' })).status, 403);
  const queries = ['', '?', '?language=', '?language=de', '?language=SK', '?language=sk,en', '?lang=sk', '?language=sk&language=en',
    '?language=auto&extra=true', '?language=AUTO', '?language=auto&language=sk', '?language=sk&model=large', '?model=large&language=sk', '?language=sk&', '?language=%73k', '/?language=sk'];
  for (const query of queries)
    assert.deepEqual(await post(runner.route + query, runner.headers), { status: 404, body: { error: 'not_found' } }, query);
  for (const method of ['GET', 'DELETE', 'PATCH'])
    assert.deepEqual(await read(await fetch(url, { method, headers: runner.headers })), { status: 405, body: { error: 'method_not_allowed' } });
  assert.equal((await fetch(url, { method: 'PUT', body, headers: { ...runner.headers, 'content-type': 'application/octet-stream' } })).status, 405);
  assert.equal(sidecar.calls.length, 0);
  for (const language of ['auto', 'sk', 'en', 'cs']) assert.equal((await post(`${runner.route}?language=${language}`, runner.headers)).status, 200);
  assert.deepEqual(sidecar.calls.map(call => call.url), ['/transcribe?language=auto', '/transcribe?language=sk', '/transcribe?language=en', '/transcribe?language=cs']);
});

test('speech route rejects unsupported media, undersized, odd and oversized audio before the sidecar', async t => {
  const sidecar = await startSidecar(t, transcript('ok'));
  const runner = await startRunner(t, { url: sidecar.url });
  const unsupported = { status: 415, body: { error: 'unsupported_media' } };
  for (const contentType of ['audio/wav', 'application/json', 'application/octet-stream; charset=binary', 'application/octet-streams', 'text/plain'])
    assert.deepEqual(await transcribe(runner, pcm(640), { headers: { 'content-type': contentType } }), unsupported, contentType);
  assert.deepEqual(await transcribe(runner, pcm(640), { headers: { 'content-encoding': 'gzip' } }), unsupported);
  assert.deepEqual(await transcribe(runner, pcm(640), { headers: { 'content-encoding': 'identity' } }), unsupported);
  const missingType = await fetch(`${runner.route}?language=sk`, { method: 'POST', body: new Uint8Array(pcm(640)), headers: runner.headers });
  assert.deepEqual(await read(missingType), unsupported);
  const invalid = { status: 400, body: { error: 'invalid_input' } };
  for (const bytes of [0, 1, 2, 638, 639, 641, 959_999])
    assert.deepEqual(await transcribe(runner, pcm(bytes)), invalid, String(bytes));
  const tooLarge = { status: 413, body: { error: 'too_large' } };
  assert.deepEqual(await rawTranscribe(runner, { 'content-length': '960001' }, request => request.flushHeaders()), tooLarge);
  assert.deepEqual(await rawTranscribe(runner, { 'content-length': '960002' }, request => request.flushHeaders()), tooLarge);
  assert.deepEqual(await rawTranscribe(runner, {}, request => {
    request.write(pcm(960_000));
    request.end(pcm(2));
  }), tooLarge);
  assert.equal(sidecar.calls.length, 0);
  assert.deepEqual(await rawTranscribe(runner, {}, request => {
    request.write(pcm(320, 7));
    request.end(pcm(320, 7));
  }), { status: 200, body: { text: 'ok' } });
  assert.deepEqual(await transcribe(runner, pcm(640), { headers: { 'content-type': 'Application/Octet-Stream' } }), { status: 200, body: { text: 'ok' } });
  assert.deepEqual(sidecar.calls.map(call => call.body.length), [640, 640]);
});

test('speech route forwards the exact audio and language and returns the trimmed transcript without storing either', async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url });
  const spoken = `prepis-${randomUUID()}`;
  for (const language of ['auto', 'sk', 'en', 'cs']) {
    const audio = randomBytes(1280);
    sidecar.state.reply = transcript(`  ${spoken} dobrý deň \n`);
    assert.deepEqual(await transcribe(runner, audio, { language }), { status: 200, body: { text: `${spoken} dobrý deň` } });
    const call = sidecar.calls.at(-1)!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `/transcribe?language=${language}`);
    assert.equal(call.contentType, 'application/octet-stream');
    assert.equal(call.body.equals(audio), true);
  }
  for (const silence of ['', '   ', '\n\t ']) {
    sidecar.state.reply = transcript(silence);
    assert.deepEqual(await transcribe(runner, pcm(640)), { status: 200, body: { text: '' } });
  }
  const longest = randomBytes(960_000);
  sidecar.state.reply = transcript('é'.repeat(4000));
  assert.deepEqual(await transcribe(runner, longest), { status: 200, body: { text: 'é'.repeat(4000) } });
  assert.equal(sidecar.calls.at(-1)!.body.equals(longest), true);
  const response = await fetch(`${runner.route}?language=sk`, {
    method: 'POST', body: new Uint8Array(pcm(640)), headers: { ...runner.headers, 'content-type': 'application/octet-stream' },
  });
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await response.arrayBuffer();
  assert.equal(sidecar.state.peak, 1);
  const stored = await storedBytes(runner.root);
  assert.equal(stored.includes(Buffer.from(spoken)), false);
  assert.equal(stored.includes(longest.subarray(0, 64)), false);
});

test('every invalid sidecar answer maps to speech_unavailable and the route recovers', async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url });
  const raw = (status: number, body: string | Buffer, headers: Record<string, string> = {}): Reply => call => {
    call.response.writeHead(status, headers);
    call.response.end(body);
  };
  const padded = (bytes: number) => JSON.stringify({ text: 'ok' }).padEnd(bytes, ' ');
  const replies: ReadonlyArray<readonly [string, Reply]> = [
    ['500', call => json(call, 500, { text: 'ok' })],
    ['503', call => json(call, 503, { detail: 'Transcriber busy' })],
    ['201', call => json(call, 201, { text: 'ok' })],
    ['204', raw(204, '')],
    ['307 redirect', raw(307, '', { location: '/transcribe?language=sk' })],
    ['301 redirect', raw(301, '', { location: 'http://127.0.0.1:1/transcribe' })],
    ['not JSON', raw(200, 'not json')],
    ['empty body', raw(200, '')],
    ['invalid UTF-8', raw(200, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]))],
    ['array', call => json(call, 200, ['ok'])],
    ['null', call => json(call, 200, null)],
    ['string', call => json(call, 200, 'ok')],
    ['empty object', call => json(call, 200, {})],
    ['numeric text', call => json(call, 200, { text: 5 })],
    ['null text', call => json(call, 200, { text: null })],
    ['unknown field', call => json(call, 200, { text: 'ok', language: 'sk' })],
    ['wrong field', call => json(call, 200, { transcript: 'ok' })],
    ['oversized text', transcript('a'.repeat(4001))],
    ['oversized padded text', transcript(' '.repeat(4001))],
    ['oversized declared body', raw(200, padded(32_769))],
    ['oversized streamed body', call => {
      call.response.writeHead(200);
      call.response.write(padded(20_000));
      call.response.end(' '.repeat(20_000));
    }],
    ['truncated body', call => {
      call.response.writeHead(200, { 'content-length': '100' });
      call.response.write('{"text":"o', () => call.response.socket?.destroy());
    }],
    ['reset connection', call => { call.response.socket?.destroy(); }],
  ];
  for (const [name, reply] of replies) {
    sidecar.state.reply = reply;
    assert.deepEqual(await transcribe(runner, pcm(640)), unavailable, name);
  }
  assert.equal(sidecar.calls.length, replies.length);
  sidecar.state.reply = raw(200, padded(32_768));
  assert.deepEqual(await transcribe(runner, pcm(640)), { status: 200, body: { text: 'ok' } });
  assert.equal(sidecar.state.peak, 1);
});

test('sidecar timeout, refused connection and a stalled upload settle within the deadline', async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url, timeoutMs: 750 });
  assert.deepEqual(await transcribe(runner, pcm(640)), unavailable);
  assert.equal(await sidecar.calls[0]!.completed, false);
  sidecar.state.reply = transcript('after timeout');
  assert.deepEqual(await transcribe(runner, pcm(640)), { status: 200, body: { text: 'after timeout' } });
  assert.deepEqual(await rawTranscribe(runner, { 'content-length': '640' }, request => { request.write(pcm(100)); }), busy);
  assert.equal(sidecar.calls.length, 2);
  assert.deepEqual(await transcribe(runner, pcm(640)), { status: 200, body: { text: 'after timeout' } });
  const refused = await startRunner(t, { url: await unusedLoopbackUrl() });
  assert.deepEqual(await transcribe(refused, pcm(640)), unavailable);
  assert.deepEqual(await transcribe(refused, pcm(640)), unavailable);
});

test('admission keeps one sidecar request in flight, bounds the wait and releases slots after completion and client abort', { timeout: 60_000 }, async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url });
  const attempt = (signal?: AbortSignal) => transcribe(runner, pcm(640), signal ? { signal } : {}).catch((): Outcome => ({ status: 0, body: null }));
  const burst = async (): Promise<readonly Outcome[]> => {
    sidecar.state.reply = hold;
    const outcomes = Array.from({ length: 12 }, () => attempt());
    await settled(outcomes, 7);
    sidecar.answer(transcript('done'));
    return Promise.all(outcomes);
  };
  const admitted = (outcomes: readonly Outcome[]) => outcomes.filter(outcome => outcome.status === 200).length;

  const first = await burst();
  assert.equal(admitted(first), 5);
  assert.deepEqual(first.filter(outcome => outcome.status !== 200), Array.from({ length: 7 }, () => busy));
  assert.equal(sidecar.calls.length, 5);
  assert.equal(sidecar.state.peak, 1);
  assert.equal(admitted(await burst()), 5);
  assert.equal(sidecar.calls.length, 10);

  sidecar.state.reply = hold;
  const clients = Array.from({ length: 12 }, () => new AbortController());
  const outcomes = clients.map(client => attempt(client.signal));
  await settled(outcomes, 7);
  const inFlight = await sidecar.received(11);
  assert.equal(sidecar.calls.length, 11);
  for (const client of clients) client.abort();
  const aborted = await Promise.all(outcomes);
  assert.equal(aborted.filter(outcome => outcome.status === 0).length, 5);
  assert.deepEqual(aborted.filter(outcome => outcome.status !== 0), Array.from({ length: 7 }, () => busy));
  assert.equal(await inFlight.completed, false);

  let recovered = 0;
  for (let round = 0; round < 40 && recovered !== 5; round += 1) recovered = admitted(await burst());
  assert.equal(recovered, 5);
  assert.equal(sidecar.state.peak, 1);
});

test('real service admits in FIFO order, releases aborted waiters and fails closed after close', async t => {
  const sidecar = await startSidecar(t);
  const service = new SpeechTranscriptionService(new HttpSpeechTranscriber(sidecar.url));
  t.after(() => service.close());
  const clip = (marker: number) => (async function* () { yield pcm(640, marker); })();
  const never = new AbortController().signal;
  const start = (marker: number, signal: AbortSignal = never) =>
    service.transcribe('en', clip(marker), signal).then(value => value, (error: Error) => error.message);

  const clients = Array.from({ length: 5 }, () => new AbortController());
  const results = clients.map((client, index) => start(index + 1, client.signal));
  assert.equal(await start(9), 'busy');
  const first = await sidecar.received(1);
  assert.equal(first.body[0], 1);

  clients[2]!.abort();
  assert.equal(await results[2], 'speech_unavailable');
  const replacement = start(6);
  assert.equal(await start(9), 'busy');

  clients[0]!.abort();
  assert.equal(await results[0], 'speech_unavailable');
  assert.equal(await first.completed, false);
  const second = await sidecar.received(2);
  assert.equal(second.body[0], 2);
  assert.equal(sidecar.calls.length, 2);
  sidecar.answer(call => json(call, 200, { text: ` clip ${call.body[0]} ` }));
  assert.deepEqual(await results[1], { text: 'clip 2' });
  assert.deepEqual(await results[3], { text: 'clip 4' });
  assert.deepEqual(await results[4], { text: 'clip 5' });
  assert.deepEqual(await replacement, { text: 'clip 6' });
  assert.deepEqual(sidecar.calls.map(call => call.body[0]), [1, 2, 4, 5, 6]);
  assert.equal(sidecar.state.peak, 1);

  sidecar.state.reply = hold;
  const pending = Array.from({ length: 5 }, (_, index) => start(index + 10));
  assert.equal(await start(9), 'busy');
  const active = await sidecar.received(6);
  await service.close();
  assert.deepEqual(await Promise.all(pending), Array.from({ length: 5 }, () => 'speech_unavailable'));
  assert.equal(await active.completed, false);
  assert.equal(sidecar.calls.length, 6);
  assert.equal(await start(9), 'speech_unavailable');
});

test('real service answers busy when the deadline passes before forwarding and frees the slot', async t => {
  const sidecar = await startSidecar(t, transcript('ok'));
  const service = new SpeechTranscriptionService(new HttpSpeechTranscriber(sidecar.url), { timeoutMs: 200 });
  t.after(() => service.close());
  const stalled = (async function* (): AsyncGenerator<Uint8Array> { await new Promise<never>(() => undefined); })();
  const signal = new AbortController().signal;
  const waiting = Array.from({ length: 5 }, () => service.transcribe('cs', stalled, signal).then(() => 'resolved', (error: Error) => error.message));
  assert.deepEqual(await Promise.all(waiting), Array.from({ length: 5 }, () => 'busy'));
  assert.equal(sidecar.calls.length, 0);
  const clip = (async function* () { yield pcm(640); })();
  assert.deepEqual(await service.transcribe('cs', clip, signal), { text: 'ok' });
  const oversized = (async function* () { yield pcm(960_000); yield pcm(2); })();
  await assert.rejects(service.transcribe('cs', oversized, signal), { message: 'too_large' });
  const odd = (async function* () { yield pcm(641); })();
  await assert.rejects(service.transcribe('cs', odd, signal), { message: 'invalid_input' });
  assert.equal(sidecar.calls.length, 1);
});

test('runner shutdown aborts the in-flight sidecar request and answers speech_unavailable', { timeout: 20_000 }, async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url });
  const pending = transcribe(runner, pcm(640));
  const inFlight = await sidecar.received(1);
  await runner.close();
  assert.deepEqual(await pending, unavailable);
  assert.equal(await inFlight.completed, false);
  assert.equal(sidecar.calls.length, 1);
  await assert.rejects(fetch(runner.base + '/healthz'));
});

test('a refused full-size clip that is still uploading receives the JSON error instead of a reset', { timeout: 30_000 }, async t => {
  const sidecar = await startSidecar(t);
  const runner = await startRunner(t, { url: sidecar.url });
  const outcomes = Array.from({ length: 12 }, () => transcribe(runner, pcm(640)));
  await settled(outcomes, 7);
  await sidecar.received(1);
  const refusals = await Promise.all(Array.from({ length: 3 }, () => uploadBeforeReading(runner, randomBytes(960_000), 8, 25)));
  assert.deepEqual(refusals, Array.from({ length: 3 }, () => ({ status: 503, body: '{"error":"busy"}' })));
  assert.equal(sidecar.calls.length, 1);
  sidecar.answer(transcript('done'));
  assert.equal((await Promise.all(outcomes)).filter(outcome => outcome.status === 200).length, 5);
  assert.equal(sidecar.calls.length, 5);
  assert.equal(sidecar.calls.some(call => call.body.length !== 640), false);

  await runner.speech!.close();
  assert.deepEqual(await uploadBeforeReading(runner, randomBytes(960_000), 8, 25), { status: 503, body: '{"error":"speech_unavailable"}' });
  assert.deepEqual(await transcribe(runner, pcm(640)), unavailable);
  assert.equal(sidecar.calls.length, 5);
});

test('refusals discard the body within byte and time bounds without holding an admission slot', async t => {
  const sidecar = await startSidecar(t);
  const service = new SpeechTranscriptionService(new HttpSpeechTranscriber(sidecar.url), { refusalDrainMs: 300 });
  t.after(() => service.close());
  const signal = new AbortController().signal;
  const clip = () => (async function* () { yield pcm(640); })();
  const code = (work: Promise<unknown>) => work.then(() => 'resolved', (error: Error) => error.message);
  const admitted = Array.from({ length: 5 }, () => service.transcribe('sk', clip(), signal).then(value => value.text, (error: Error) => error.message));
  await sidecar.received(1);

  const consumed = { chunks: 0, bytes: 0 };
  const counted = (chunks: number, bytes: number) => (async function* () {
    for (let index = 0; index < chunks; index += 1) {
      consumed.chunks += 1;
      consumed.bytes += bytes;
      yield pcm(bytes);
    }
  })();
  assert.equal(await code(service.transcribe('sk', counted(8, 120_000), signal)), 'busy');
  assert.deepEqual(consumed, { chunks: 8, bytes: 960_000 });
  consumed.chunks = 0;
  consumed.bytes = 0;
  assert.equal(await code(service.transcribe('sk', counted(1000, 120_000), signal)), 'busy');
  assert.deepEqual(consumed, { chunks: 9, bytes: 1_080_000 });

  const stalled = () => (async function* (): AsyncGenerator<Uint8Array> { await new Promise<never>(() => undefined); })();
  const draining = Array.from({ length: 8 }, () => code(service.transcribe('sk', stalled(), signal)));
  const disconnected = new AbortController();
  const abandoned = code(service.transcribe('sk', stalled(), disconnected.signal));
  disconnected.abort();
  assert.equal(await abandoned, 'busy');
  sidecar.answer(transcript('done'));
  assert.deepEqual(await Promise.all(admitted), Array.from({ length: 5 }, () => 'done'));
  assert.deepEqual(await service.transcribe('sk', clip(), signal), { text: 'done' });
  assert.equal(sidecar.calls.length, 6);
  assert.deepEqual(await Promise.all(draining), Array.from({ length: 8 }, () => 'busy'));

  await service.close();
  consumed.chunks = 0;
  consumed.bytes = 0;
  assert.equal(await code(service.transcribe('sk', counted(8, 120_000), signal)), 'speech_unavailable');
  assert.deepEqual(consumed, { chunks: 8, bytes: 960_000 });
  assert.equal(await code(service.transcribe('sk', stalled(), signal)), 'speech_unavailable');
  assert.equal(sidecar.calls.length, 6);
});
