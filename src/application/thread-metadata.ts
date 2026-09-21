import { metadataTaskId, parseThreadOrder, type ThreadOrder, parseThreadMetadataPatch, type ThreadMetadata, type ThreadMetadataPage, type ThreadMetadataPatch } from '../domain/thread-metadata.js';
export interface ThreadMetadataRepository {
  reorderThread(id: string, input: ThreadOrder): Promise<{ items: readonly ThreadMetadata[] }>;
  getThreadMetadata(id: string): Promise<ThreadMetadata>;
  listThreadMetadata(after: string): Promise<ThreadMetadataPage>;
  patchThreadMetadata(id: string, patch: ThreadMetadataPatch): Promise<ThreadMetadata>;
}
export class ThreadMetadataService {
  constructor(private readonly repository: ThreadMetadataRepository) {}
  reorder(id: unknown, input: unknown): Promise<{ items: readonly ThreadMetadata[] }> { return this.repository.reorderThread(metadataTaskId(id), parseThreadOrder(input)); }
  get(id: unknown): Promise<ThreadMetadata> { return this.repository.getThreadMetadata(metadataTaskId(id)); }
  list(after: unknown = ''): Promise<ThreadMetadataPage> { return this.repository.listThreadMetadata(after === '' ? '' : metadataTaskId(after)); }
  patch(id: unknown, input: unknown): Promise<ThreadMetadata> { return this.repository.patchThreadMetadata(metadataTaskId(id), parseThreadMetadataPatch(input)); }
}
