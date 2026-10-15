// Gutters between treemap cells. Pure: no DOM, no gotchea-core.
import { squarify, type LayoutCell, type Rect } from './squarify.js';

/** Cells never shrink below this, so a tiny chunk stays a visible, focusable sliver. */
export const MIN_CELL_PX = 2;

/**
 * Reserve gutters inside the original LOC-weighted slots. Keeping squarify's input
 * rectangle unchanged preserves its row choices and allocation of area by LOC.
 */
export function squarifyWithGap<T>(items: readonly T[], rect: Rect, value: (item: T) => number, gap: number): LayoutCell<T>[] {
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  return squarify(items, rect, value).map(({ item, rect: r }) => ({ item, rect: inset(r, g) }));
}

function inset(r: Rect, gap: number): Rect {
  const sx = Math.min(gap, Math.max(0, r.w - MIN_CELL_PX));
  const sy = Math.min(gap, Math.max(0, r.h - MIN_CELL_PX));
  return { x: r.x + sx / 2, y: r.y + sy / 2, w: r.w - sx, h: r.h - sy };
}
