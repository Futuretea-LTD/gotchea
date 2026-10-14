// Pool-level operations on top of a QuestionStore (M2_DESIGN.md §9): insert,
// usable counts and staleness by chunkHash. A question is only valid for the exact
// chunk hash it was generated against; refs are never rebased (decision D1).
import type { QuestionPrivate } from '../model/question.js';
import type { QuestionStore } from './types.js';

/** Stale: marked by a scan, or generated against a hash other than the chunk's current one. */
export function isStale(q: Pick<QuestionPrivate, 'status' | 'chunkHash'>, currentHash: string): boolean {
  return q.status === 'stale' || q.chunkHash !== currentHash;
}

/**
 * Quizzable: `ok`, not flagged and, when `currentHash` is given, generated against it.
 * Without a hash only status and flag are checked.
 */
export function isUsable(q: Pick<QuestionPrivate, 'status' | 'flagged' | 'chunkHash'>, currentHash?: string): boolean {
  return q.status === 'ok' && !q.flagged && (currentHash === undefined || q.chunkHash === currentHash);
}

export function usableQuestions<Q extends Pick<QuestionPrivate, 'status' | 'flagged' | 'chunkHash'>>(pool: readonly Q[], currentHash?: string): Q[] {
  return pool.filter((q) => isUsable(q, currentHash));
}

/** Dedupe base for generation: `ok` questions at the current hash, flagged ones included. */
export function dedupeBase<Q extends Pick<QuestionPrivate, 'status' | 'chunkHash'>>(pool: readonly Q[], currentHash: string): Q[] {
  return pool.filter((q) => !isStale(q, currentHash));
}

/** Marks every `ok` question whose hash differs from `currentHash` as stale. */
export function markStale(pool: readonly QuestionPrivate[], currentHash: string): { pool: QuestionPrivate[]; staled: number } {
  let staled = 0;
  const next = pool.map((q) => {
    if (q.status !== 'ok' || q.chunkHash === currentHash) return q;
    staled++;
    return { ...q, status: 'stale' as const };
  });
  return { pool: next, staled };
}

export async function countUsable(store: QuestionStore, chunkId: string, currentHash?: string): Promise<number> {
  return usableQuestions(await store.list(chunkId), currentHash).length;
}

export interface InsertResult {
  inserted: QuestionPrivate[];
  /** Ids already in the pool; those questions were not written. */
  duplicateIds: string[];
  pool: QuestionPrivate[];
}

/** Appends questions to a chunk's pool under the store's per-chunk lock; ids already present are skipped. */
export async function insertQuestions(store: QuestionStore, chunkId: string, questions: readonly QuestionPrivate[]): Promise<InsertResult> {
  const inserted: QuestionPrivate[] = [];
  const duplicateIds: string[] = [];
  const pool = await store.update(chunkId, (current) => {
    const ids = new Set(current.map((q) => q.id));
    for (const q of questions) {
      if (q.chunkId !== chunkId) throw new Error(`question ${q.id} belongs to ${q.chunkId}, not ${chunkId}`);
      if (ids.has(q.id)) duplicateIds.push(q.id);
      else {
        ids.add(q.id);
        inserted.push(q);
      }
    }
    return [...current, ...inserted];
  });
  return { inserted, duplicateIds, pool };
}
