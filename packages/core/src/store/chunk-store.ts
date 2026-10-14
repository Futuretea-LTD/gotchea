// `.gotchea/chunks.json` (shared, committed). Written sorted with a fixed key order.
import type { ChunksFile } from '../model/chunk.js';
import { readJsonFile, writeFileAtomic } from './atomic-write.js';
import { serializeChunksFile } from './json.js';
import { repoPaths } from './paths.js';
import type { ChunkStore } from './types.js';

function validateChunksFile(data: unknown, where: string): ChunksFile {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Invalid chunks file ${where}: expected a JSON object`);
  }
  const v = (data as { version?: unknown }).version;
  if (v !== 1) {
    throw new Error(`Unsupported chunks file version ${JSON.stringify(v)} in ${where} (expected 1)`);
  }
  if (!Array.isArray((data as { chunks?: unknown }).chunks)) {
    throw new Error(`Invalid chunks file ${where}: "chunks" must be an array`);
  }
  return data as ChunksFile;
}

export class FsChunkStore implements ChunkStore {
  readonly path: string;

  constructor(root: string) {
    this.path = repoPaths(root).chunks;
  }

  async load(): Promise<ChunksFile | null> {
    const data = await readJsonFile<unknown>(this.path);
    return data === null ? null : validateChunksFile(data, this.path);
  }

  async save(file: ChunksFile): Promise<void> {
    await writeFileAtomic(this.path, serializeChunksFile(file));
  }
}

export class InMemoryChunkStore implements ChunkStore {
  private file: ChunksFile | null;

  constructor(initial: ChunksFile | null = null) {
    this.file = initial === null ? null : structuredClone(initial);
  }

  async load(): Promise<ChunksFile | null> {
    return this.file === null ? null : validateChunksFile(structuredClone(this.file), '(memory)');
  }

  async save(file: ChunksFile): Promise<void> {
    // Round-trip through the serializer so ordering matches the Fs store.
    this.file = JSON.parse(serializeChunksFile(file)) as ChunksFile;
  }
}
