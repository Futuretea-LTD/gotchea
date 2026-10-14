import { pad, percent } from './format/strings';
import { Stats, clamp } from './math';

export function report(values: number[]): string {
  const stats = new Stats();
  for (const v of values) stats.add(clamp(v, 0, 1));
  return pad('mean', 8) + percent(stats.mean());
}
