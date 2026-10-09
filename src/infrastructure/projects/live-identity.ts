import { RunnerError } from '../../domain/contracts.js';

type Identity = Readonly<{ dev: number; ino: number }>;

export function liveIdentity(persisted: Identity, live: Identity): Identity {
  if (live.ino !== persisted.ino) throw new RunnerError('conflict');
  return { dev: live.dev, ino: live.ino };
}
