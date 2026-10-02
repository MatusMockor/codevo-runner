export type OwnedProcess = Readonly<{ pid: number; start: string }>;

export interface OwnedProcessTree {
  snapshot(): readonly OwnedProcess[];
}

export interface ProcessOwnershipSink {
  attach(tree: OwnedProcessTree): () => void;
}
