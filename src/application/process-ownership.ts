import type { TaskIsolation } from '../domain/contracts.js';
import type { OwnedProcessTree, ProcessOwnershipSink } from '../domain/process-ownership.js';

export type AgentProcessScope = Readonly<{ conversationId: string; projectId: string; isolation: TaskIsolation }>;
export type OwnedTrees = Readonly<{ trees: readonly OwnedProcessTree[]; complete: boolean }>;

export interface ProcessOwnershipLease extends ProcessOwnershipSink {
  release(): void;
}

export interface AgentProcessOwnership {
  open(scope: AgentProcessScope): ProcessOwnershipLease;
}

const TREES_PER_LEASE = 4;

type Lease = { readonly scope: AgentProcessScope; readonly trees: Set<OwnedProcessTree>; overflow: boolean; released: boolean };

export class ProcessOwnershipRegistry implements AgentProcessOwnership {
  private readonly leases = new Set<Lease>();

  open(scope: AgentProcessScope): ProcessOwnershipLease {
    const lease: Lease = { scope: Object.freeze({ ...scope }), trees: new Set(), overflow: false, released: false };
    this.leases.add(lease);
    return {
      attach: tree => this.attach(lease, tree),
      release: () => {
        lease.released = true;
        lease.trees.clear();
        this.leases.delete(lease);
      },
    };
  }

  conversation(conversationId: string): OwnedTrees {
    return this.collect(scope => scope.conversationId === conversationId);
  }

  inPlaceProject(projectId: string): OwnedTrees {
    return this.collect(scope => scope.projectId === projectId && scope.isolation === 'in-place');
  }

  private attach(lease: Lease, tree: OwnedProcessTree): () => void {
    if (lease.released) return () => {};
    if (lease.trees.size >= TREES_PER_LEASE) {
      lease.overflow = true;
      return () => {};
    }
    lease.trees.add(tree);
    return () => { lease.trees.delete(tree); };
  }

  private collect(matches: (scope: AgentProcessScope) => boolean): OwnedTrees {
    const selected = [...this.leases].filter(lease => matches(lease.scope));
    return {
      trees: selected.flatMap(lease => [...lease.trees]),
      complete: selected.every(lease => !lease.overflow),
    };
  }
}
