// FSRS-lite retrievability (PLAN.md §3). Pure: `now` is always injected.
import type { ScoreConfig } from '../config/schema.js';

const MS_PER_DAY = 86_400_000;
/** Largest timestamp a JS Date can hold (ECMAScript limit, not a tunable). */
const MAX_DATE_MS = 8.64e15;

/** R(t, S) = (1 + t / (F·S))^-1, with t clamped at 0. Result is in (0, 1]. */
export function retrievability(stability: number, elapsedDays: number, cfg: Pick<ScoreConfig, 'forgettingFactor'>): number {
  const t = Math.max(0, elapsedDays);
  return 1 / (1 + t / (cfg.forgettingFactor * stability));
}

/** Days until R drops to `target` (inverse of `retrievability`). */
export function daysUntil(stability: number, target: number, cfg: Pick<ScoreConfig, 'forgettingFactor'>): number {
  return cfg.forgettingFactor * stability * (1 / target - 1);
}

export function elapsedDays(fromIso: string, now: Date): number {
  return (now.getTime() - Date.parse(fromIso)) / MS_PER_DAY;
}

/** `fromIso + days`, or null when the result is not a representable date (bad input, huge or infinite `days`). */
export function addDays(fromIso: string, days: number): string | null {
  const ms = Date.parse(fromIso) + days * MS_PER_DAY;
  return Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null;
}
