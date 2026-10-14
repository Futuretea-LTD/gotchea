// Progress transitions (PLAN.md §3 "Score transitions", §5 reconcile). Pure.
import type { ScoreConfig } from '../config/schema.js';
import type { Progress, ProgressHistoryEntry } from '../model/progress.js';

export interface SessionResult {
  passed: boolean;
  at: string;
  /** Chunk contentHash at quiz time. */
  hash: string;
  sessionId: string;
  questionIds: string[];
  correct: number;
  total: number;
}

/** Fresh progress for a chunk that has never been reviewed. */
export function emptyProgress(hash: string): Progress {
  return { stability: null, lastReviewedAt: null, lastPassedHash: null, lastSeenHash: hash, mustRepass: false, history: [] };
}

/**
 * First pass (`lastPassedHash == null`) sets S = initialStability; later passes
 * multiply S by passMultiplier. A fail sets S = max(minS, (S ?? minS) × failMultiplier)
 * and `mustRepass`. A pass clears `mustRepass` and records the hash.
 */
export function onSessionResult(p: Progress | undefined, r: SessionResult, cfg: ScoreConfig): Progress {
  const prev = p ?? emptyProgress(r.hash);
  const entry: ProgressHistoryEntry = {
    at: r.at,
    sessionId: r.sessionId,
    questionIds: [...r.questionIds],
    correct: r.correct,
    total: r.total,
    passed: r.passed,
    hash: r.hash,
  };
  const base = { ...prev, lastReviewedAt: r.at, lastSeenHash: r.hash, history: [...prev.history, entry] };
  if (r.passed) {
    const stability =
      prev.lastPassedHash === null || prev.stability === null
        ? cfg.initialStability
        : prev.stability * cfg.passMultiplier;
    return { ...base, stability, lastPassedHash: r.hash, mustRepass: false };
  }
  const stability = Math.max(cfg.minStability, (prev.stability ?? cfg.minStability) * cfg.failMultiplier);
  return { ...base, stability, mustRepass: true };
}

/**
 * Decay after a content change: S = max(minS, S × max(floor, 1 − changeRatio)).
 * changeRatio > redOnChangeRatio forces a re-pass. Always records `newHash` as seen.
 */
export function onContentChange(p: Progress, changeRatio: number, newHash: string, cfg: ScoreConfig): Progress {
  const ratio = Math.min(1, Math.max(0, changeRatio));
  const factor = Math.max(cfg.changeDecayFloor, 1 - ratio);
  const stability = p.stability === null ? null : Math.max(cfg.minStability, p.stability * factor);
  return {
    ...p,
    stability,
    lastSeenHash: newHash,
    mustRepass: p.mustRepass || ratio > cfg.redOnChangeRatio,
  };
}
