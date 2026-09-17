import { isAbsolute } from 'node:path';

type Launch = Readonly<{ executable: string; args: readonly string[]; cwd: string;
  cwdIdentity?: Readonly<{ dev: number; ino: number }> }>;

// Fixed program, never constructed from workspace content. argv carries metadata;
// stdin remains exclusively owned by the provider protocol. exec retains the PID
// and detached process group owned by the existing cancellation/timeout guard.
const PINNED_EXEC = `import os, sys
try:
    root, device, inode, executable = sys.argv[1:5]
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    observed = os.fstat(fd)
    if observed.st_dev != int(device) or observed.st_ino != int(inode):
        raise RuntimeError('workspace_identity_changed')
    os.fchdir(fd)
    os.close(fd)
except Exception:
    sys.stderr.write('workspace_identity_changed\\n')
    sys.exit(125)
try:
    os.execvpe(executable, [executable] + sys.argv[5:], os.environ)
except Exception:
    sys.stderr.write('provider_unavailable\\n')
    sys.exit(126)
`;

/** Validate a bounded private launch recipe, then pin cwd immediately before exec. */
export function pinnedSpawnPlan(plan: Launch): Launch {
  if (!plan.cwdIdentity) return plan;
  const { dev, ino } = plan.cwdIdentity;
  const values = [plan.cwd, plan.executable, ...plan.args];
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0 ||
    !isAbsolute(plan.cwd) || !plan.executable || plan.args.length > 256 ||
    values.some(value => value.includes('\0') || Buffer.byteLength(value) > 32_768) ||
    values.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0) > 131_072) {
    throw new Error('workspace_identity_invalid');
  }
  return { executable: '/usr/bin/python3', cwd: '/',
    args: ['-I', '-S', '-c', PINNED_EXEC, plan.cwd, String(dev), String(ino), plan.executable, ...plan.args] };
}
