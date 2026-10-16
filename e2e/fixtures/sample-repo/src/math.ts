/** Inclusive bounds; reject inverted ranges before clamping. */
export function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) throw new RangeError('Inverted range');
  return Math.min(maximum, Math.max(minimum, value));
}

/** Empty collections have no average. */
export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
