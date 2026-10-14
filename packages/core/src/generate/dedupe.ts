// Near-duplicate detection: character trigrams of the normalised text + Jaccard (M2_DESIGN.md §4).
import { normalizeText } from './text.js';

/** Character trigrams of `normalizeText(s)`; a shorter non-empty text is its own single gram. */
export function trigrams(s: string): Set<string> {
  const t = normalizeText(s);
  const grams = new Set<string>();
  if (t.length === 0) return grams;
  if (t.length < 3) {
    grams.add(t);
    return grams;
  }
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

/** |a ∩ b| / |a ∪ b|; two empty sets are identical (1). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}
