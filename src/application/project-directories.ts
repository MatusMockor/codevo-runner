export type ProjectDirectoryListing = Readonly<{
  path: string;
  parentPath: string | null;
  entries: readonly Readonly<{ name: string; path: string }>[];
  truncated: boolean;
}>;
export interface ProjectDirectories {
  list(value: unknown, signal: AbortSignal): Promise<ProjectDirectoryListing>;
}
