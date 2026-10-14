// Chunk state and colors (PLAN.md §3 "Colors", §10 assumptions 9, 16, 17). Pure.
import type { QuestionBand, ScoreConfig } from '../config/schema.js';
import type { ChunkMetrics } from '../model/chunk.js';
import type { ChunkColor, ChunkState, Progress } from '../model/progress.js';
import { addDays, daysUntil, elapsedDays, retrievability } from './retrievability.js';

export interface ColorFlags {
  neverPassed: boolean;
  mustRepass: boolean;
  hasQuestions: boolean;
}

/** grey: no ok questions; red: never passed, must re-pass or R < yellowAt; yellow: R < greenAt; else green. */
export function colorFor(R: number | null, flags: ColorFlags, cfg: Pick<ScoreConfig, 'greenAt' | 'yellowAt'>): ChunkColor {
  if (!flags.hasQuestions) return 'grey';
  if (flags.neverPassed || flags.mustRepass || R === null || Number.isNaN(R) || R < cfg.yellowAt) return 'red';
  return R < cfg.greenAt ? 'yellow' : 'green';
}

/**
 * State of a leaf. Grey leaves have R = null. A leaf that was never passed has
 * R = 0 so it pulls its parents down. `dueAt` is when R falls below `greenAt`.
 */
export function chunkState(okQuestions: number, p: Progress | undefined, now: Date, cfg: ScoreConfig): ChunkState {
  const hasQuestions = okQuestions > 0;
  if (!hasQuestions) return { R: null, color: 'grey' };
  const neverPassed = !p || p.lastPassedHash === null || p.stability === null || p.lastReviewedAt === null;
  if (neverPassed) return { R: 0, color: 'red' };
  const elapsed = elapsedDays(p.lastReviewedAt!, now);
  // Hand-edited or corrupt progress (unparseable date, S <= 0) is treated as never passed.
  if (!(p.stability! > 0) || Number.isNaN(elapsed)) return { R: 0, color: 'red' };
  const R = retrievability(p.stability!, elapsed, cfg);
  const color = colorFor(R, { neverPassed, mustRepass: p.mustRepass, hasQuestions }, cfg);
  const dueAt = addDays(p.lastReviewedAt!, daysUntil(p.stability!, cfg.greenAt, cfg));
  return dueAt === null ? { R, color } : { R, color, dueAt };
}

/** LOC-weighted mean of children's R, skipping null (grey) children. Null if nothing is left. */
export function aggregate(children: readonly { loc: number; R: number | null }[]): number | null {
  let weight = 0;
  let sum = 0;
  let counted = 0;
  for (const c of children) {
    if (c.R === null) continue;
    const w = Math.max(0, c.loc);
    weight += w;
    sum += w * c.R;
    counted += 1;
  }
  if (counted === 0) return null;
  if (weight === 0) {
    // Every non-grey child is empty: fall back to an unweighted mean.
    let plain = 0;
    for (const c of children) if (c.R !== null) plain += c.R;
    return plain / counted;
  }
  return sum / weight;
}

/** A parent is grey if all children are grey; otherwise its color comes from the aggregated R only. */
export function parentState(children: readonly { loc: number; R: number | null }[], cfg: ScoreConfig): ChunkState {
  const R = aggregate(children);
  return { R, color: colorFor(R, { neverPassed: false, mustRepass: false, hasQuestions: R !== null }, cfg) };
}

/** Minimum correct answers to pass a session of `n` questions. */
export function passThreshold(n: number, ratio: number): number {
  return Math.max(0, Math.ceil(ratio * n - 1e-9));
}

/** First band whose `maxLoc`/`maxComplexity` limits hold; falls back to the last band. */
export function questionCount(m: Pick<ChunkMetrics, 'loc' | 'complexity'>, cfg: { bands: readonly QuestionBand[] }): number {
  for (const b of cfg.bands) {
    if ((b.maxLoc === undefined || m.loc <= b.maxLoc) && (b.maxComplexity === undefined || m.complexity <= b.maxComplexity)) {
      return b.count;
    }
  }
  return cfg.bands[cfg.bands.length - 1]?.count ?? 0;
}

/** 1 + w · ln(1 + fanIn): how much a chunk's importers raise its priority. */
export function fanInFactor(fanIn: number, cfg: { fanInWeight: number }): number {
  return 1 + cfg.fanInWeight * Math.log1p(Math.max(0, fanIn));
}

/** (1 − R) · fanInFactor; a null R (never passed) counts as 0. */
export function selectionPriority(R: number | null, fanIn: number, cfg: { fanInWeight: number }): number {
  return (1 - (R ?? 0)) * fanInFactor(fanIn, cfg);
}
