export type TurnChangedFile = Readonly<{
  relativePath: string;
  oldRelativePath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  addedLines: number | null;
  deletedLines: number | null;
}>;
export type TurnChangesSummary = Readonly<{
  turnId: string;
  state: 'ready' | 'unavailable';
  files: readonly TurnChangedFile[];
  truncated: boolean;
  reason: string | null;
}>;
export type TurnFileDiff = Readonly<{
  relativePath: string;
  original: Readonly<{ text: string; truncated: boolean }>;
  modified: Readonly<{ text: string; truncated: boolean }>;
  unavailableReason: 'binary' | 'large' | null;
}>;
