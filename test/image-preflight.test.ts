import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { validateImageEnvelope } from '../src/infrastructure/files/image-preflight.js';
import { RunnerError, LIMITS } from '../src/domain/contracts.js';

const code = (expected: string) => (error: unknown) => error instanceof RunnerError && error.code === expected;
const chunk = (type: string, data: Buffer) => {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  data.copy(result, 8);
  return result; // CRC is deliberately outside envelope validation; full decode validates it.
};
const png = async () => sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
const insert = (original: Buffer, ...chunks: Buffer[]) => Buffer.concat([original.subarray(0, 33), ...chunks, original.subarray(33)]);

test('normal PNG and baseline/progressive JPEG pass preflight without mutation', async () => {
  const source = await png();
  for (const [bytes, media] of [[source, 'image/png'], [await sharp(source).jpeg().toBuffer(), 'image/jpeg'], [await sharp(source).jpeg({ progressive: true }).toBuffer(), 'image/jpeg']] as const) {
    const before = Buffer.from(bytes);
    validateImageEnvelope(bytes, media);
    assert.deepEqual(bytes, before);
  }
});

test('rejects MIME mismatch, truncation, trailing content and oversized dimensions', async () => {
  const bytes = await png();
  assert.throws(() => validateImageEnvelope(bytes, 'image/jpeg'), code('unsupported_media'));
  assert.throws(() => validateImageEnvelope(bytes.subarray(0, 40), 'image/png'), code('unsupported_media'));
  assert.throws(() => validateImageEnvelope(Buffer.concat([bytes, Buffer.from([0])]), 'image/png'), code('unsupported_media'));
  bytes.writeUInt32BE(LIMITS.imageDimension + 1, 16);
  assert.throws(() => validateImageEnvelope(bytes, 'image/png'), code('too_large'));
});

test('bounded compressed PNG metadata and international text accepted; malformed forms rejected', async () => {
  const bytes = await png();
  const compressed = deflateSync(Buffer.from('short text'));
  for (const type of ['zTXt', 'iCCP']) {
    validateImageEnvelope(insert(bytes, chunk(type, Buffer.concat([Buffer.from('name\0\0'), compressed]))), 'image/png');
    assert.throws(() => validateImageEnvelope(insert(bytes, chunk(type, Buffer.from('name\0\x01x'))), 'image/png'), code('unsupported_media'));
  }
  validateImageEnvelope(insert(bytes, chunk('iTXt', Buffer.concat([Buffer.from('name\0\x01\0en\0title\0'), compressed]))), 'image/png');
  validateImageEnvelope(insert(bytes, chunk('iTXt', Buffer.from('name\0\0\0en\0title\0text'))), 'image/png');
  assert.throws(() => validateImageEnvelope(insert(bytes, chunk('iTXt', Buffer.from('name\0\x01\0en'))), 'image/png'), code('unsupported_media'));
  assert.throws(() => validateImageEnvelope(insert(bytes, chunk('zTXt', Buffer.from('name\0\0bad'))), 'image/png'), code('unsupported_media'));
});

test('PNG metadata and segment counts are bounded before native decode', async () => {
  const bytes = await png();
  assert.throws(() => validateImageEnvelope(insert(bytes, chunk('tEXt', Buffer.alloc(256 * 1024 + 1))), 'image/png'), code('too_large'));
  assert.throws(() => validateImageEnvelope(insert(bytes, ...Array.from({ length: 1024 }, () => chunk('tEXt', Buffer.alloc(0)))), 'image/png'), code('too_large'));
  const broken = chunk('tEXt', Buffer.alloc(0));
  broken.writeUInt32BE(0xffffffff);
  assert.throws(() => validateImageEnvelope(insert(bytes, broken), 'image/png'), code('unsupported_media'));
});

test('macOS screenshot shaped PNG passes preflight and still decodes', async () => {
  const bytes = await png();
  const screenshot = insert(
    bytes,
    chunk('iCCP', Buffer.concat([Buffer.from('name\0\0'), deflateSync(Buffer.from('short text'))])),
    chunk('cICP', Buffer.from([1, 13, 0, 1])),
    chunk('eXIf', Buffer.from('MM\0*\0\0\0\x08\0\0\0\0\0\0', 'latin1')),
    chunk('pHYs', Buffer.alloc(9, 1)),
    chunk('iTXt', Buffer.from('name\0\0\0en\0title\0text')),
    chunk('iDOT', Buffer.alloc(28)),
  );
  const before = Buffer.from(screenshot);
  validateImageEnvelope(screenshot, 'image/png');
  assert.deepEqual(screenshot, before);
  const decoder = sharp(screenshot, { failOn: 'warning' });
  const metadata = await decoder.metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 3);
  await decoder.stats();
});

test('unknown ancillary PNG chunks are accepted within the metadata and segment bounds', async () => {
  const bytes = await png();
  const unknown = (kibibytes: number) => chunk('vpAg', Buffer.alloc(kibibytes * 1024));
  for (const type of ['vpAg', 'caBX', 'mDCV', 'cLLI', 'orNT']) validateImageEnvelope(insert(bytes, chunk(type, Buffer.from('unknown'))), 'image/png');
  validateImageEnvelope(insert(bytes, unknown(100), unknown(100)), 'image/png');
  assert.throws(() => validateImageEnvelope(insert(bytes, chunk('vpAg', Buffer.alloc(256 * 1024 + 1))), 'image/png'), code('too_large'));
  assert.throws(() => validateImageEnvelope(insert(bytes, unknown(100), unknown(100), unknown(100)), 'image/png'), code('too_large'));
  assert.throws(() => validateImageEnvelope(insert(bytes, ...Array.from({ length: 1024 }, () => chunk('vpAg', Buffer.alloc(0)))), 'image/png'), code('too_large'));
});

test('unknown critical PNG chunks and malformed chunk types fail closed', async () => {
  const bytes = await png();
  for (const type of ['VpAg', 'XxXx', 'IDOT', 'vpag', 'iD0T', 'v-Ag']) {
    assert.throws(() => validateImageEnvelope(insert(bytes, chunk(type, Buffer.from('unknown'))), 'image/png'), code('unsupported_media'));
  }
});

test('animated PNG chunks are rejected', async () => {
  const bytes = await png();
  const control = chunk('acTL', Buffer.alloc(8));
  const frame = chunk('fcTL', Buffer.alloc(26));
  const frameData = chunk('fdAT', Buffer.alloc(16));
  for (const animation of [control, frame, frameData]) {
    assert.throws(() => validateImageEnvelope(insert(bytes, animation), 'image/png'), code('unsupported_media'));
  }
  const first = insert(bytes, control, frame);
  const animated = Buffer.concat([first.subarray(0, first.length - 12), frame, frameData, first.subarray(first.length - 12)]);
  assert.throws(() => validateImageEnvelope(animated, 'image/png'), code('unsupported_media'));
  assert.throws(() => validateImageEnvelope(Buffer.concat([bytes.subarray(0, bytes.length - 12), frame, frameData, bytes.subarray(bytes.length - 12)]), 'image/png'), code('unsupported_media'));
});

test('JPEG APP metadata budget and malformed segment lengths fail closed', async () => {
  const bytes = await sharp(await png()).jpeg().toBuffer();
  const segment = Buffer.alloc(60_004);
  segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(60_002, 2);
  const oversized = Buffer.concat([bytes.subarray(0, 2), ...Array.from({ length: 5 }, () => segment), bytes.subarray(2)]);
  assert.throws(() => validateImageEnvelope(oversized, 'image/jpeg'), code('too_large'));
  assert.throws(() => validateImageEnvelope(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]), 'image/jpeg'), code('unsupported_media'));
  assert.throws(() => validateImageEnvelope(bytes.subarray(0, bytes.length - 1), 'image/jpeg'), code('unsupported_media'));
});
