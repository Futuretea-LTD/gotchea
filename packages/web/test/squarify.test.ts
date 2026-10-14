import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutTree, squarify, type Rect } from '../src/layout/squarify.js';

const EPS = 1e-6;
const area = (r: Rect) => r.w * r.h;
const id = (v: number) => v;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function assertTiling(values: number[], rect: Rect): void {
  const cells = squarify(values, rect, id);
  const positive = values.filter((v) => v > 0);
  expect(cells).toHaveLength(positive.length);
  const tol = EPS * Math.max(1, area(rect));
  const total = positive.reduce((s, v) => s + v, 0);
  // Total area equals the rectangle (nothing when every value is 0), and each cell is proportional to its value.
  const expected = positive.length === 0 ? 0 : area(rect);
  expect(Math.abs(cells.reduce((s, c) => s + area(c.rect), 0) - expected)).toBeLessThanOrEqual(tol);
  for (const c of cells) {
    expect(Math.abs(area(c.rect) - (c.item / total) * area(rect))).toBeLessThanOrEqual(tol);
    expect(c.rect.w).toBeGreaterThanOrEqual(-EPS);
    expect(c.rect.h).toBeGreaterThanOrEqual(-EPS);
    expect(c.rect.x).toBeGreaterThanOrEqual(rect.x - tol);
    expect(c.rect.y).toBeGreaterThanOrEqual(rect.y - tol);
    expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(rect.x + rect.w + tol);
    expect(c.rect.y + c.rect.h).toBeLessThanOrEqual(rect.y + rect.h + tol);
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) expect(overlap(cells[i]!.rect, cells[j]!.rect)).toBeLessThanOrEqual(tol);
  }
}

describe('squarify', () => {
  it('a single child fills the whole rectangle', () => {
    const rect = { x: 10, y: 20, w: 300, h: 100 };
    expect(squarify([42], rect, id)).toEqual([{ item: 42, rect }]);
  });

  it('0-LOC items get no cell, the rest still tile the rectangle', () => {
    const cells = squarify([0, 5, 0, 5], { x: 0, y: 0, w: 10, h: 10 }, id);
    expect(cells.map((c) => c.item)).toEqual([5, 5]);
    assertTiling([0, 5, 0, 5], { x: 0, y: 0, w: 10, h: 10 });
  });

  it('nothing to lay out: no items, all zero, NaN/negative, or an empty rectangle', () => {
    expect(squarify([], { x: 0, y: 0, w: 10, h: 10 }, id)).toEqual([]);
    expect(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }, id)).toEqual([]);
    expect(squarify([Number.NaN, -3, Number.POSITIVE_INFINITY], { x: 0, y: 0, w: 10, h: 10 }, id)).toEqual([]);
    expect(squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 }, id)).toEqual([]);
  });

  it('orders by value, keeps input order on ties, and yields squarish cells for the classic example', () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const cells = squarify(values, { x: 0, y: 0, w: 6, h: 4 }, id);
    expect(cells.map((c) => c.item)).toEqual([6, 6, 4, 3, 2, 2, 1]);
    // Bruls et al.: the first row is the two 6s stacked in a 3-wide strip.
    expect(cells[0]!.rect).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(cells[1]!.rect).toEqual({ x: 0, y: 2, w: 3, h: 2 });
    for (const c of cells) expect(Math.max(c.rect.w / c.rect.h, c.rect.h / c.rect.w)).toBeLessThan(4);
  });

  it('property: tiles any rectangle exactly, without overlap or overflow', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100_000 }), fc.double({ min: 0.001, max: 1000, noNaN: true })), {
          maxLength: 60,
        }),
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -500, max: 500, noNaN: true }),
          w: fc.double({ min: 0.5, max: 4000, noNaN: true }),
          h: fc.double({ min: 0.5, max: 4000, noNaN: true }),
        }),
        (values, rect) => assertTiling(values, rect),
      ),
      { numRuns: 400 },
    );
  });
});

describe('layoutTree', () => {
  interface N {
    id: string;
    loc: number;
    children: N[];
  }
  const n = (id: string, loc: number, children: N[] = []): N => ({ id, loc, children });

  it('nests children inside their parent cell up to maxDepth', () => {
    const tree = n('.', 30, [n('a', 20, [n('a/x', 10), n('a/y', 10)]), n('b', 10), n('z', 0)]);
    const rect = { x: 0, y: 0, w: 30, h: 10 };
    expect(layoutTree(tree, rect, (c) => c.loc).map((c) => c.item.id)).toEqual(['a', 'b']);
    const deep = layoutTree(tree, rect, (c) => c.loc, { maxDepth: 2 });
    expect(deep.map((c) => [c.item.id, c.depth])).toEqual([
      ['a', 1],
      ['a/x', 2],
      ['a/y', 2],
      ['b', 1],
    ]);
    const a = deep[0]!.rect;
    for (const c of deep.filter((d) => d.depth === 2)) {
      expect(c.rect.x).toBeGreaterThanOrEqual(a.x);
      expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(a.x + a.w + EPS);
    }
  });

  it('applies the inset before laying out children', () => {
    const tree = n('.', 10, [n('a', 10, [n('a/x', 10)])]);
    const cells = layoutTree(tree, { x: 0, y: 0, w: 10, h: 10 }, (c) => c.loc, {
      maxDepth: 2,
      inset: (r) => ({ x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }),
    });
    expect(cells[1]!.rect).toEqual({ x: 1, y: 1, w: 8, h: 8 });
  });
});
