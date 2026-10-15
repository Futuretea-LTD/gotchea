import { describe, expect, it } from 'vitest';
import { MIN_CELL_PX, squarifyWithGap } from '../src/layout/gap.js';
import { squarify } from '../src/layout/squarify.js';

const box = { x: 0, y: 0, w: 960, h: 540 };
const weight = (n: number) => n;

describe('treemap gutters', () => {
  it('keeps the original LOC allocation and row choices, with 6px gutters inside the slots', () => {
    const values = [60, 30, 10, 0];
    const slots = squarify(values, box, weight);
    const cells = squarifyWithGap(values, box, weight, 6);
    expect(cells.map((c) => c.item)).toEqual([60, 30, 10]);
    cells.forEach((c, i) => {
      const slot = slots[i]!.rect;
      expect(c.rect).toEqual({ x: slot.x + 3, y: slot.y + 3, w: slot.w - 6, h: slot.h - 6 });
      expect((c.rect.w + 6) * (c.rect.h + 6)).toBeCloseTo(box.w * box.h * c.item / 100);
    });
  });

  it('does not inflate tiny cells or move them outside their LOC slots', () => {
    const values = [1000000, 1];
    const slots = squarify(values, box, weight);
    const cells = squarifyWithGap(values, box, weight, 6);
    cells.forEach(({ rect: r }, i) => {
      const slot = slots[i]!.rect;
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(slot.x);
      expect(r.y).toBeGreaterThanOrEqual(slot.y);
      expect(r.x + r.w).toBeLessThanOrEqual(slot.x + slot.w);
      expect(r.y + r.h).toBeLessThanOrEqual(slot.y + slot.h);
    });
  });

  it('shrinks a narrow slot only down to MIN_CELL_PX, never below it', () => {
    // 960x540 split 1000:4 gives the small slot about 3.8px of width; a 6px gutter would erase it.
    const [, small] = squarify([1000, 4], box, weight);
    const [, cell] = squarifyWithGap([1000, 4], box, weight, 6);
    expect(small!.rect.w).toBeLessThan(6 + MIN_CELL_PX);
    expect(cell!.rect.w).toBeCloseTo(MIN_CELL_PX);
    expect(cell!.rect.x).toBeCloseTo(small!.rect.x + (small!.rect.w - cell!.rect.w) / 2);
    expect(cell!.rect.h).toBe(small!.rect.h - 6);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('uses no gutter for %s', (gap) => {
    expect(squarifyWithGap([3, 2], box, weight, gap)).toEqual(squarify([3, 2], box, weight));
  });

  it('keeps empty layouts empty', () => {
    expect(squarifyWithGap([0, -1], box, weight, 6)).toEqual([]);
    expect(squarifyWithGap([3, 2], { ...box, w: 0 }, weight, 6)).toEqual([]);
  });
});
