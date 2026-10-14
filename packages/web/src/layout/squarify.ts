// Squarified treemap layout (Bruls, Huizing, van Wijk 2000). Pure: no DOM, no gotchea-core.
// Rows are laid along the shorter side of the free rectangle and grown while the worst
// aspect ratio in the row improves. The last cell of a row and the last row absorb
// rounding error, so the cells tile the rectangle exactly.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutCell<T> {
  item: T;
  rect: Rect;
}

/** Highest aspect ratio in a row of `areas` (sum `sum`) laid along a side of length `side`. */
function worst(sum: number, max: number, min: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Cells for `items` with area proportional to `value(item)`, tiling `rect`. Items with a
 * value of 0 (or negative / non-finite) get no cell; callers list them separately.
 * Output is ordered by descending value (ties keep input order).
 */
export function squarify<T>(items: readonly T[], rect: Rect, value: (item: T) => number): LayoutCell<T>[] {
  const weighted = items
    .map((item, index) => ({ item, index, v: value(item) }))
    .filter((e) => Number.isFinite(e.v) && e.v > 0)
    .sort((a, b) => b.v - a.v || a.index - b.index);
  if (weighted.length === 0 || !(rect.w > 0) || !(rect.h > 0)) return [];

  const total = weighted.reduce((s, e) => s + e.v, 0);
  const scale = (rect.w * rect.h) / total;
  const areas = weighted.map((e) => e.v * scale);
  const out: LayoutCell<T>[] = [];
  let { x, y, w, h } = rect;
  let i = 0;

  while (i < areas.length) {
    const side = Math.min(w, h);
    let end = i + 1;
    let sum = areas[i]!;
    let best = worst(sum, areas[i]!, areas[i]!, side);
    while (end < areas.length) {
      const next = sum + areas[end]!;
      const ratio = worst(next, areas[i]!, areas[end]!, side);
      if (ratio > best) break;
      sum = next;
      best = ratio;
      end++;
    }

    const lastRow = end === areas.length;
    if (w >= h) {
      // Vertical strip on the left, cells stacked top to bottom.
      const stripW = lastRow ? w : Math.min(w, sum / h);
      let cy = y;
      for (let k = i; k < end; k++) {
        const ch = k === end - 1 ? y + h - cy : areas[k]! / stripW;
        out.push({ item: weighted[k]!.item, rect: { x, y: cy, w: stripW, h: ch } });
        cy += ch;
      }
      x += stripW;
      w = Math.max(0, w - stripW);
    } else {
      // Horizontal strip on top, cells left to right.
      const stripH = lastRow ? h : Math.min(h, sum / w);
      let cx = x;
      for (let k = i; k < end; k++) {
        const cw = k === end - 1 ? x + w - cx : areas[k]! / stripH;
        out.push({ item: weighted[k]!.item, rect: { x: cx, y, w: cw, h: stripH } });
        cx += cw;
      }
      y += stripH;
      h = Math.max(0, h - stripH);
    }
    i = end;
  }
  return out;
}

export interface TreeInput {
  children: readonly TreeInput[];
}

export interface TreeCell<T> extends LayoutCell<T> {
  depth: number;
}

/**
 * Nested layout: each node's children tile its cell, down to `maxDepth` levels below
 * `root` (1 = only the root's children). `inset` shrinks a parent's cell before its
 * children are laid out (room for a label/border). Parents come before their children.
 */
export function layoutTree<T extends TreeInput>(
  root: T,
  rect: Rect,
  value: (node: T) => number,
  opts: { maxDepth?: number; inset?: (rect: Rect, depth: number) => Rect } = {},
): TreeCell<T>[] {
  const maxDepth = opts.maxDepth ?? 1;
  const out: TreeCell<T>[] = [];
  const visit = (node: T, area: Rect, depth: number): void => {
    for (const cell of squarify(node.children as readonly T[], area, value)) {
      out.push({ ...cell, depth });
      if (depth < maxDepth && cell.item.children.length > 0) {
        visit(cell.item, opts.inset ? opts.inset(cell.rect, depth) : cell.rect, depth + 1);
      }
    }
  };
  visit(root, rect, 1);
  return out;
}
