import { inflateSync } from 'node:zlib';
import { LIMITS, RunnerError, type MediaType } from '../../domain/contracts.js';

const METADATA_BYTES = 256 * 1024;
const INFLATED_CHUNK_BYTES = 64 * 1024;
const MAX_SEGMENTS = 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_ANCILLARY = new Set(['cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'tRNS', 'pHYs', 'sPLT', 'tIME', 'tEXt', 'eXIf']);
function invalid(): never { throw new RunnerError('unsupported_media'); }
function oversized(): never { throw new RunnerError('too_large'); }

function dimensions(width: number, height: number): void {
  if (!width || !height) invalid();
  if (width > LIMITS.imageDimension || height > LIMITS.imageDimension || width * height > LIMITS.imagePixels) oversized();
}

function inflatedSize(data: Buffer): number {
  if (!data.length) invalid();
  try {
    return inflateSync(data, { maxOutputLength: INFLATED_CHUNK_BYTES }).length;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') oversized();
    return invalid();
  }
}

function keywordEnd(data: Buffer): number {
  const end = data.indexOf(0);
  if (end < 1 || end > 79) invalid();
  // PNG keywords use printable Latin-1, without leading/trailing/repeated spaces.
  for (let i = 0; i < end; i++) {
    const value = data[i]!;
    if (value < 32 || (value > 126 && value < 161) || (value === 32 && (i === 0 || i === end - 1 || data[i - 1] === 32))) invalid();
  }
  return end;
}

function compressedMetadata(type: string, data: Buffer): number {
  const end = keywordEnd(data);
  if (type !== 'iTXt') {
    if (data[end + 1] !== 0) invalid();
    return inflatedSize(data.subarray(end + 2));
  }
  const flag = data[end + 1];
  if ((flag !== 0 && flag !== 1) || data[end + 2] !== 0) invalid();
  const languageEnd = data.indexOf(0, end + 3);
  if (languageEnd < 0) invalid();
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) invalid();
  return flag === 1 ? inflatedSize(data.subarray(translatedEnd + 1)) : 0;
}

function png(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) invalid();
  let offset = 8;
  let count = 0;
  let metadata = 0;
  let hasData = false;
  let dataEnded = false;
  let hasPalette = false;
  while (offset < bytes.length) {
    if (++count > MAX_SEGMENTS) oversized();
    if (bytes.length - offset < 12) invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (count === 1) {
      if (type !== 'IHDR' || length !== 13) invalid();
      dimensions(data.readUInt32BE(0), data.readUInt32BE(4));
      continue;
    }
    if (type === 'IDAT') {
      if (dataEnded) invalid();
      hasData = true;
      continue;
    }
    if (hasData) dataEnded = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasData || offset !== bytes.length) invalid();
      return;
    }
    if (type === 'PLTE') {
      if (hasPalette || hasData || !length || length > 768 || length % 3 !== 0) invalid();
      hasPalette = true;
      continue;
    }
    metadata += length;
    if (metadata > METADATA_BYTES) oversized();
    const compressed = type === 'zTXt' || type === 'iCCP' || type === 'iTXt';
    if (!compressed && !PNG_ANCILLARY.has(type)) invalid();
    if (compressed) metadata += compressedMetadata(type, data);
    if (metadata > METADATA_BYTES) oversized();
  }
  invalid();
}

function jpeg(bytes: Buffer): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2;
  let count = 0;
  let metadata = 0;
  let scanning = false;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (scanning) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    }
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) invalid();
    if (marker === 0 && scanning) continue;
    if (++count > MAX_SEGMENTS) oversized();
    if (marker >= 0xd0 && marker <= 0xd7 && scanning) continue;
    scanning = false;
    if (marker === 0xd9) {
      if (!hasFrame || !hasScan || offset !== bytes.length) invalid();
      return;
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (bytes.length - offset < 2) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) invalid();
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      metadata += length - 2;
      if (metadata > METADATA_BYTES) oversized();
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (hasFrame || length < 8) invalid();
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      hasFrame = true;
    } else if (marker === 0xda) {
      if (!hasFrame || length < 6) invalid();
      scanning = true;
      hasScan = true;
    } else if (marker !== 0xc4 && marker !== 0xdb && marker !== 0xdd) invalid();
    offset += length;
  }
  invalid();
}

/** Resource envelope only; the caller must still fully decode to validate pixels. */
export function validateImageEnvelope(bytes: Uint8Array, mediaType: MediaType): void {
  if (bytes.byteLength > LIMITS.attachmentBytes) oversized();
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === 'image/png') return png(data);
  if (mediaType === 'image/jpeg') return jpeg(data);
  invalid();
}
