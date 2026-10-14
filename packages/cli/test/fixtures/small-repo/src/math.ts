/** Clamps `n` into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

export class Stats {
  private readonly values: number[] = [];

  add(v: number): this {
    this.values.push(v);
    return this;
  }

  mean(): number {
    return mean(this.values);
  }

  max(): number | null {
    if (this.values.length === 0) return null;
    let best = this.values[0]!;
    for (const v of this.values) if (v > best) best = v;
    return best;
  }
}
