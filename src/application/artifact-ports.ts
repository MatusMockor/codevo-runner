import type { Artifact } from '../domain/artifact.js';
export interface ArtifactRepository {
  listArtifactIds(): Promise<readonly string[]>;
  putArtifact(artifact: Artifact, path: string): Promise<{ artifact: Artifact; created: boolean }>;
  findArtifact(taskId: string, path: string): Promise<Artifact | null>;
  getArtifact(taskId: string, id: string): Promise<Artifact>;
  listArtifacts(taskId: string): Promise<readonly Artifact[]>;
}
export interface ArtifactWorkspace {
  normalize(taskId: string, path: string): Promise<string>;
  capture(taskId: string, path: string): Promise<Readonly<{ path: string; bytes: Uint8Array }>>;
}
export interface ArtifactBlobStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  read(artifact: Artifact): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
}
export interface ArtifactApplication {
  register(taskId: string, input: unknown): Promise<{ artifact: Artifact; created: boolean }>;
  list(taskId: string): Promise<Readonly<{ items: readonly Artifact[] }>>;
  read(taskId: string, id: string): Promise<Readonly<{ artifact: Artifact; bytes: Uint8Array }>>;
}
