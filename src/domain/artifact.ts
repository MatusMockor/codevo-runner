import { RunnerError } from './contracts.js';
export const ARTIFACT_LIMITS = Object.freeze({ perTask: 32, storageBytes: 1024 * 1024 * 1024, imageBytes: 8 * 1024 * 1024, htmlBytes: 2 * 1024 * 1024 });
export type ArtifactMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'text/html';
export type Artifact = Readonly<{ id: string; taskId: string; name: string; mediaType: ArtifactMediaType; sizeBytes: number; sha256: string }>;
export function parseArtifactPath(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('path' in input) ||
      typeof input.path !== 'string' || !input.path || Buffer.byteLength(input.path) > 4096 || /[\\\x00-\x1f]/.test(input.path) ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input.path) || input.path.split('/').some(part => part === '..' || part.toLowerCase() === '.git'))
    throw new RunnerError('invalid_input');
  return input.path;
}
export function artifactMediaType(path: string): ArtifactMediaType {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (extension) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.html': case '.htm': return 'text/html';
    default: throw new RunnerError('unsupported_media');
  }
}
