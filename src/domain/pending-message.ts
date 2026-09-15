import type { MessagePart } from './contracts.js';
import type { AgentLaunchOptions } from './launch.js';

export const PENDING_LIMITS = Object.freeze({ perConversation: 16, retained: 1000 });
export type PendingMessage = Readonly<{
  id: string; conversationId: string;
  status: 'queued' | 'paused' | 'dispatched' | 'cancelled';
  parts: readonly MessagePart[]; launch?: AgentLaunchOptions;
  createdAt: string; taskId: string | null;
}>;
export type PendingMessages = Readonly<{ items: readonly PendingMessage[] }>;
