import { randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadIdentity(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, 'identity');
  const temporary = join(directory, `.identity-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomUUID() + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const saved = await open(destination, 'r');
  try {
    const buffer = Buffer.alloc(38);
    const { bytesRead } = await saved.read(buffer, 0, buffer.length, 0);
    const id = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead === buffer.length || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw new Error('Stored runner identity is invalid; refusing to replace it');
    return id;
  } finally {
    await saved.close();
  }
}
