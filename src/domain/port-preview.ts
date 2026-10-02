export const PORT_PREVIEW_LIMITS = Object.freeze({ minPort: 1024, maxPort: 65535, ports: 32, processBytes: 15 });

export const PORT_ADDRESSES = ['loopback-v4', 'loopback-v6', 'any-v4', 'any-v6'] as const;
export const PORT_SOURCES = ['agent', 'terminal'] as const;
export type PortAddress = (typeof PORT_ADDRESSES)[number];
export type PortSource = (typeof PORT_SOURCES)[number];
export type ListeningPort = Readonly<{ port: number; address: PortAddress; source: PortSource; process: string }>;
export type PortList = Readonly<{ ports: readonly ListeningPort[]; truncated: boolean; scannedAt: string }>;

const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function comparePorts(left: ListeningPort, right: ListeningPort): number {
  return left.port - right.port ||
    PORT_ADDRESSES.indexOf(left.address) - PORT_ADDRESSES.indexOf(right.address) ||
    PORT_SOURCES.indexOf(left.source) - PORT_SOURCES.indexOf(right.source);
}

export function processName(value: string): string {
  return value.length > 0 && value.length <= PORT_PREVIEW_LIMITS.processBytes && /^[\x20-\x7e]+$/.test(value) ? value : 'unknown';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isListeningPort(value: unknown): value is ListeningPort {
  return isRecord(value) && hasExactKeys(value, ['port', 'address', 'source', 'process']) &&
    typeof value.port === 'number' && Number.isSafeInteger(value.port) &&
    value.port >= PORT_PREVIEW_LIMITS.minPort && value.port <= PORT_PREVIEW_LIMITS.maxPort &&
    (PORT_ADDRESSES as readonly unknown[]).includes(value.address) &&
    (PORT_SOURCES as readonly unknown[]).includes(value.source) &&
    typeof value.process === 'string' && processName(value.process) === value.process && value.process !== '';
}

export function isPortList(value: unknown): value is PortList {
  if (!isRecord(value) || !hasExactKeys(value, ['ports', 'truncated', 'scannedAt']) ||
      typeof value.truncated !== 'boolean' || typeof value.scannedAt !== 'string' ||
      value.scannedAt.length > 64 || !TIMESTAMP.test(value.scannedAt) ||
      !Array.isArray(value.ports) || value.ports.length > PORT_PREVIEW_LIMITS.ports) return false;
  const ports: readonly unknown[] = value.ports;
  return ports.every((port, index) => isListeningPort(port) &&
    (index === 0 || comparePorts(ports[index - 1] as ListeningPort, port) < 0));
}

export type PortListOptions = Readonly<{ excludedPorts: ReadonlySet<number>; truncated: boolean; scannedAt: string }>;

export function previewablePort(port: number, excludedPorts: ReadonlySet<number>): boolean {
  return Number.isSafeInteger(port) && port >= PORT_PREVIEW_LIMITS.minPort && port <= PORT_PREVIEW_LIMITS.maxPort && !excludedPorts.has(port);
}

export function portList(candidates: readonly ListeningPort[], options: PortListOptions): PortList {
  const unique = new Map<string, ListeningPort>();
  for (const candidate of candidates) {
    if (!previewablePort(candidate.port, options.excludedPorts)) continue;
    const key = `${candidate.port}:${candidate.address}:${candidate.source}`;
    const name = processName(candidate.process);
    const existing = unique.get(key);
    if (!existing || name < existing.process) unique.set(key, { ...candidate, process: name });
  }
  const sorted = [...unique.values()].sort(comparePorts);
  return {
    ports: sorted.slice(0, PORT_PREVIEW_LIMITS.ports),
    truncated: options.truncated || sorted.length > PORT_PREVIEW_LIMITS.ports,
    scannedAt: options.scannedAt,
  };
}
