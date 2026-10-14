// Myers O(ND) line diff over fingerprint arrays (PLAN.md §5 reconcile). Pure.

export interface LineDiffStats {
  added: number;
  removed: number;
  /** Length of the longest common subsequence. */
  common: number;
}

/** Counts added/removed lines between `a` (old) and `b` (new) with Myers' greedy algorithm. */
export function lineDiff(a: readonly string[], b: readonly string[]): LineDiffStats {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return { added: 0, removed: 0, common: 0 };
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2;
        return { added: m - common, removed: n - common, common };
      }
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable: Myers diff did not terminate');
}

/** changed = max(added, removed); ratio = min(1, changed / max(1, old.length)). A missing snapshot counts as 1. */
export function changeRatio(oldLines: readonly string[] | null, newLines: readonly string[]): number {
  if (oldLines === null) return 1;
  const { added, removed } = lineDiff(oldLines, newLines);
  return Math.min(1, Math.max(added, removed) / Math.max(1, oldLines.length));
}
