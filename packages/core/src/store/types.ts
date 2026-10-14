// Storage contracts (PLAN.md §3). Fs* implementations write atomically
// (tmp + rename); InMemory* implementations back the tests.
import type { ChunksFile } from '../model/chunk.js';
import type { ProgressFile } from '../model/progress.js';
import type { QuestionPrivate } from '../model/question.js';
import type { Session } from '../quiz/session.js';

export interface ChunkStore {
  load(): Promise<ChunksFile | null>;
  save(file: ChunksFile): Promise<void>;
}

export interface QuestionStore {
  list(chunkId: string): Promise<QuestionPrivate[]>;
  /** Replaces the chunk's pool. An empty list removes the file. */
  save(chunkId: string, questions: QuestionPrivate[]): Promise<void>;
  remove(chunkId: string): Promise<void>;
  /**
   * Read → `fn` → write, serialised per chunk within this process so concurrent
   * writers never lose each other's questions. Returns the saved pool.
   */
  update(chunkId: string, fn: (pool: QuestionPrivate[]) => QuestionPrivate[] | Promise<QuestionPrivate[]>): Promise<QuestionPrivate[]>;
  /** Moves the pool to a new chunk id and rewrites each question's `chunkId`. */
  move(fromId: string, toId: string): Promise<void>;
  /** Chunk ids that currently have a question file. */
  chunkIds(): Promise<string[]>;
}

export interface ProgressStore {
  /** A missing file yields an empty progress file for the store's repoId. */
  load(): Promise<ProgressFile>;
  save(file: ProgressFile): Promise<void>;
}

/** Normalized-line fingerprints per content hash, kept locally for changeRatio. */
export interface SnapshotStore {
  get(hash: string): Promise<string[] | null>;
  put(hash: string, lineFingerprints: string[]): Promise<void>;
}

/** Quiz sessions, one file each. Corrupt or missing sessions read as null. */
export interface SessionStore {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  /** Every readable session; corrupt files are skipped. */
  list(): Promise<Session[]>;
  /** Removes unreadable session files and stray `.tmp` files last modified before `olderThanMs`; returns how many. */
  purgeBroken(olderThanMs: number): Promise<number>;
}
