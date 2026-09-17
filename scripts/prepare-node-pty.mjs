import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// node-pty 1.1.0 ships its macOS spawn helper without the executable bit.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  const entry = await stat(helper);
  if (!entry.isFile()) throw new Error('node-pty spawn helper is not a regular file');
  await chmod(helper, entry.mode | 0o100);
}
