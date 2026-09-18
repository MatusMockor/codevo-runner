import { RunnerError } from '../domain/contracts.js';
import { validateId } from '../domain/task-input.js';
import { parseSteerInput, SteeringNotSent, type ProviderSteer, type SteerClaim, type SteerReceipt } from '../domain/steering.js';
import type { ExecutionAttachmentStager, ExecutionRepository, StagedExecutionInputs } from './execution-ports.js';

type Owner = {
  readonly taskId: string;
  readonly signal: AbortSignal;
  handler?: ProviderSteer;
  busy: boolean;
  closed: boolean;
  retainedImages: number;
  readonly inputs: StagedExecutionInputs[];
  operation?: Promise<unknown>;
};
/** Active delivery is separate from output retention and the terminal continuation queue. */
export class SteeringService {
  private owner?: Owner;
  constructor(private readonly repository: ExecutionRepository, private readonly attachments?: ExecutionAttachmentStager) {}

  open(taskId: string, signal: AbortSignal) {
    const owner: Owner = { taskId, signal, busy: false, closed: false, retainedImages: 0, inputs: [] };
    this.owner = owner;
    return {
      ready: (handler: ProviderSteer | undefined) => { if (this.owner === owner && !owner.closed) owner.handler = handler; },
      boundary: async () => {
        if (!this.valid(owner) || owner.busy || !owner.handler || !this.repository.claimPendingSteer) return;
        try { await this.withOwner(owner, () => this.repository.claimPendingSteer!(taskId)); }
        catch { /* Pending messages remain durable. Never retry an uncertain write. */ }
      },
      close: async () => {
        owner.closed = true;
        owner.handler = undefined;
        if (this.owner === owner) this.owner = undefined;
        await owner.operation?.catch(() => undefined);
        const settled = await Promise.allSettled(owner.inputs.map(input => input.cleanup()));
        if (settled.some(result => result.status === 'rejected')) throw new RunnerError('storage_unavailable');
      },
    };
  }

  async steer(taskId: string, value: unknown): Promise<SteerReceipt> {
    validateId(taskId);
    const input = parseSteerInput(value);
    if (!this.repository.findSteer || !this.repository.claimSteer) throw new RunnerError('conflict');
    const previous = await this.repository.findSteer(taskId, input);
    if (previous) return previous;
    const owner = this.requireOwner(taskId);
    const receipt = await this.withOwner(owner, () => this.repository.claimSteer!(taskId, input));
    if (!receipt) throw new RunnerError('conflict');
    return receipt;
  }

  async pending(taskId: string, pendingId: string): Promise<SteerReceipt> {
    validateId(taskId); validateId(pendingId);
    if (!this.repository.findPendingSteer || !this.repository.claimPendingSteer) throw new RunnerError('conflict');
    const previous = await this.repository.findPendingSteer(taskId, pendingId);
    if (previous) return previous;
    const owner = this.requireOwner(taskId);
    const receipt = await this.withOwner(owner, () => this.repository.claimPendingSteer!(taskId, pendingId));
    if (!receipt) throw new RunnerError('conflict');
    return receipt;
  }

  private valid(owner: Owner): boolean { return this.owner === owner && !owner.closed && !owner.signal.aborted; }
  private requireOwner(taskId: string): Owner {
    const owner = this.owner;
    if (!owner || owner.taskId !== taskId || !this.valid(owner) || !owner.handler) throw new RunnerError('conflict');
    return owner;
  }
  private async withOwner(owner: Owner, claim: () => Promise<SteerClaim | null>): Promise<SteerReceipt | null> {
    if (owner.busy) throw new RunnerError('busy');
    owner.busy = true;
    const operation = this.deliver(owner, claim);
    owner.operation = operation;
    try { return await operation; }
    finally { owner.busy = false; if (owner.operation === operation) owner.operation = undefined; }
  }
  private async releaseUndelivered(owner: Owner, message: SteerClaim, staged?: StagedExecutionInputs): Promise<void> {
    if (staged) {
      await staged.cleanup();
      const index = owner.inputs.indexOf(staged);
      if (index >= 0) owner.inputs.splice(index, 1);
      owner.retainedImages -= staged.attachments.length;
    }
    await this.repository.releaseSteer?.(message.taskId, message.messageId);
  }
  private async deliver(owner: Owner, claim: () => Promise<SteerClaim | null>): Promise<SteerReceipt | null> {
    const handler = owner.handler;
    if (!this.valid(owner) || !handler || !this.repository.acceptSteer) throw new RunnerError('conflict');
    const message = await claim();
    if (!message) return null;
    if (message.accepted) return { taskId: message.taskId, messageId: message.messageId, status: 'accepted' };
    let staged: StagedExecutionInputs | undefined;
    try {
    if (!this.valid(owner) || owner.handler !== handler) throw new RunnerError('conflict');
    const ids = message.parts.flatMap(part => part.type === 'attachment' ? [part.attachmentId] : []);
    if (ids.length) {
      if (!this.attachments) throw new RunnerError('unsupported_media');
      // At most 64 MiB of follow-up image files retained for a live process.
      if (owner.retainedImages + ids.length > 8) throw new RunnerError('quota_exceeded');
      staged = await this.attachments.stage(message.messageId, ids);
      // Retain files through provider completion: an ACK can precede image consumption.
      owner.inputs.push(staged);
      owner.retainedImages += ids.length;
    }
    if (!this.valid(owner) || owner.handler !== handler) throw new RunnerError('conflict');
    } catch (error) {
      // No provider call occurred; safely release durable admission for a later retry.
      await this.releaseUndelivered(owner, message, staged);
      throw error;
    }
    try {
      await handler({ idempotencyKey: message.messageId,
        prompt: message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
        attachments: staged?.attachments ?? [] });
    } catch (error) {
      if (error instanceof SteeringNotSent) {
        await this.releaseUndelivered(owner, message, staged);
        throw new RunnerError('conflict');
      }
      throw new RunnerError('delivery_uncertain');
    }
    // ACK commits even if Stop races after provider accepted input; never permit redelivery.
    return this.repository.acceptSteer(message.taskId, message.messageId);
  }
}
