// Personal progress (PLAN.md §3). Stored under ~/.gotchea/repos/<repoId>/progress.json,
// never committed. `ChunkState` is computed, never stored.

export interface ProgressHistoryEntry {
  at: string;
  sessionId: string;
  questionIds: string[];
  correct: number;
  total: number;
  passed: boolean;
  hash: string;
}

export interface Progress {
  /** Stability S in days; null = never reviewed. */
  stability: number | null;
  lastReviewedAt: string | null;
  lastPassedHash: string | null;
  /** Hash the decay was last reconciled against. */
  lastSeenHash: string;
  /** Set by a fail or by changeRatio > redOnChangeRatio; cleared by a pass. */
  mustRepass: boolean;
  history: ProgressHistoryEntry[];
}

export interface ProgressFile {
  version: 1;
  repoId: string;
  /** Keyed by chunk id. */
  chunks: Record<string, Progress>;
}

export type ChunkColor = 'grey' | 'red' | 'yellow' | 'green';

export interface ChunkState {
  R: number | null;
  color: ChunkColor;
  dueAt?: string;
}
