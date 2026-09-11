import { createHash, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';

export async function loadAuthorization(path: string) {
  const file = await open(path, 'r');
  let token: string;
  try {
    const buffer = Buffer.alloc(258);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead === buffer.length || !/^[a-zA-Z0-9_-]{32,256}$/.test(token))
      throw new Error('Token file must contain 32–256 base64url characters');
  } finally {
    await file.close();
  }
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return (header: string | undefined): boolean => {
    if (!header || header.length > 263) return false;
    return timingSafeEqual(expected, createHash('sha256').update(header).digest());
  };
}
