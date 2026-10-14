import { describe, expect, it } from 'vitest';
import { changeRatio, lineDiff } from '../../src/scan/line-diff.js';

const lines = (s: string) => (s === '' ? [] : s.split(''));

describe('lineDiff (Myers)', () => {
  it.each([
    ['', '', 0, 0],
    ['abc', 'abc', 0, 0],
    ['', 'abc', 3, 0],
    ['abc', '', 0, 3],
    ['abcabba', 'cbabac', 2, 3],
    ['abcdef', 'abXdef', 1, 1],
    ['abcdef', 'abcdefgh', 2, 0],
    ['abcdef', 'bcdef', 0, 1],
  ])('%s → %s: +%i -%i', (a, b, added, removed) => {
    const d = lineDiff(lines(a), lines(b));
    expect(d).toEqual({ added, removed, common: a.length - removed });
  });

  it('handles larger inputs', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i % 100 === 0 ? `${l}!` : l));
    expect(lineDiff(a, b)).toEqual({ added: 20, removed: 20, common: 1980 });
  });
});

describe('changeRatio', () => {
  it('is max(added, removed) / old length, capped at 1', () => {
    expect(changeRatio(lines('abcdefghij'), lines('abcdefghiX'))).toBeCloseTo(0.1, 12);
    expect(changeRatio(lines('abcd'), lines('abcdXYZW'))).toBe(1);
    expect(changeRatio(lines('abcd'), lines('abcd'))).toBe(0);
  });
  it('is 1 when the old snapshot is missing and uses max(1, old) as denominator', () => {
    expect(changeRatio(null, lines('abc'))).toBe(1);
    expect(changeRatio([], lines('a'))).toBe(1);
    expect(changeRatio([], [])).toBe(0);
  });
});
