// Injectable randomness for question order and option permutations (M3_DESIGN.md §3.4).
import { randomInt } from 'node:crypto';

/** Uniform integer in `[0, maxExclusive)`. */
export interface Rng {
  int(maxExclusive: number): number;
}

export type Permutation = [number, number, number, number];

/** Unbiased (rejection sampling inside Node). The default everywhere outside tests. */
export const cryptoRng: Rng = { int: (n) => randomInt(n) };

/** mulberry32: deterministic, for tests and debugging only. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n) => Math.floor(next() * n) };
}

/** Fisher–Yates over `[0, 1, 2, 3]`; `perm[displayIndex] = originalIndex`. Independent of the answer key. */
export function makePermutation(rng: Rng): Permutation {
  const p = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = rng.int(i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p as Permutation;
}

/** In-place-free Fisher–Yates shuffle. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
