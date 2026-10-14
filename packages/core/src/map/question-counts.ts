// Read-only view over the question pools: how many usable questions each chunk has.
import type { Chunk } from '../model/chunk.js';
import { usableQuestions } from '../store/question-pool.js';
import { FsQuestionStore } from '../store/question-store.js';

/**
 * Usable question count per chunk id for the repo at `repoRoot`: `ok`, not flagged and,
 * when `chunks` is given, generated against the chunk's current `contentHash` (chunks
 * missing from `chunks` count 0). Chunks without usable questions are omitted. Carries
 * counts only, never stems, options, answers or explanations.
 */
export async function okQuestionCounts(repoRoot: string, chunks?: readonly Pick<Chunk, 'id' | 'contentHash'>[]): Promise<Map<string, number>> {
  const store = new FsQuestionStore(repoRoot);
  const hashes = chunks ? new Map(chunks.map((c) => [c.id, c.contentHash])) : null;
  const counts = new Map<string, number>();
  for (const id of await store.chunkIds()) {
    let hash: string | undefined;
    if (hashes) {
      hash = hashes.get(id);
      if (hash === undefined) continue;
    }
    const usable = usableQuestions(await store.list(id), hash).length;
    if (usable > 0) counts.set(id, usable);
  }
  return counts;
}
