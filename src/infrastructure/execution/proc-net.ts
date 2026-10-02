import type { PortAddress } from '../../domain/port-preview.js';

export type ByteOrder = 'LE' | 'BE';
export type SocketFamily = 'v4' | 'v6';
export type TcpListener = Readonly<{ inode: string; port: number; address: PortAddress }>;
export type TcpTable = Readonly<{ listeners: readonly TcpListener[]; truncated: boolean }>;

const LISTEN_STATE = '0A';
const INODE = /^[1-9]\d{0,19}$/;
const SOCKET_LINK = /^socket:\[([1-9]\d{0,19})\]$/;
const ADDRESS_HEX: Readonly<Record<SocketFamily, RegExp>> = { v4: /^[0-9A-Fa-f]{8}$/, v6: /^[0-9A-Fa-f]{32}$/ };
const PORT_HEX = /^[0-9A-Fa-f]{4}$/;

export function socketInode(link: string): string | undefined {
  return SOCKET_LINK.exec(link)?.[1];
}

export function decodeAddress(hex: string, order: ByteOrder): readonly number[] {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const group = [0, 2, 4, 6].map(offset => Number.parseInt(hex.slice(word + offset, word + offset + 2), 16));
    bytes.push(...(order === 'LE' ? group.reverse() : group));
  }
  return bytes;
}

export function classifyAddress(bytes: readonly number[], family: SocketFamily): PortAddress | undefined {
  const zero = bytes.every(value => value === 0);
  if (family === 'v4') {
    if (zero) return 'any-v4';
    return bytes.join('.') === '127.0.0.1' ? 'loopback-v4' : undefined;
  }
  if (zero) return 'any-v6';
  if (bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1) return 'loopback-v6';
  return bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff && bytes.slice(12).join('.') === '127.0.0.1'
    ? 'loopback-v4' : undefined;
}

export function parseTcpLine(line: string, family: SocketFamily, order: ByteOrder): TcpListener | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 10 || !/^\d+:$/.test(fields[0]!) || fields[3] !== LISTEN_STATE) return undefined;
  const local = fields[1]!.split(':');
  const inode = fields[9]!;
  if (local.length !== 2 || !ADDRESS_HEX[family].test(local[0]!) || !PORT_HEX.test(local[1]!) || !INODE.test(inode)) return undefined;
  const address = classifyAddress(decodeAddress(local[0]!, order), family);
  if (!address) return undefined;
  return { inode, port: Number.parseInt(local[1]!, 16), address };
}

export function parseTcpTable(text: string, family: SocketFamily, order: ByteOrder, maxLines: number): TcpTable {
  const lines = text.split('\n').slice(1);
  if (lines.at(-1) === '') lines.pop();
  const truncated = lines.length > maxLines;
  const listeners: TcpListener[] = [];
  for (const line of lines.slice(0, maxLines)) {
    const listener = parseTcpLine(line, family, order);
    if (listener) listeners.push(listener);
  }
  return { listeners, truncated };
}
