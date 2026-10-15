import type { StatusJson } from 'gotchea-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RETENTION_SCALE, cellTone, closestExisting, colorCounts, commandsFor, findNode, formatDue, formatR, hashFor, idFromHash, isEmptyMap, pathTo, retentionTier, shellQuote, statusStats, tierRange, upFrom } from '../src/model.js';
import { node, sampleMap } from './helpers.js';

describe('retention tones', () => {
  it('orders the scale from low to high retention', () => {
    expect(RETENTION_SCALE).toEqual(['#FF5F2E', '#FF9B6E', '#FFC4A6', '#FFE1D3', '#FDF1EC']);
  });

  it.each([
    [-Number.MAX_VALUE, 0], [-1, 0], [0, 0],
    [0.2 - Number.EPSILON, 0], [0.2, 1], [0.2 + Number.EPSILON, 1],
    [0.4 - Number.EPSILON, 1], [0.4, 2], [0.4 + Number.EPSILON, 2],
    [0.6 - Number.EPSILON, 2], [0.6, 3], [0.6 + Number.EPSILON, 3],
    [0.8 - Number.EPSILON, 3], [0.8, 4], [0.8 + Number.EPSILON, 4],
    [1, 4], [2, 4], [Number.MAX_VALUE, 4],
    [Number.NaN, 0], [Number.NEGATIVE_INFINITY, 0], [Number.POSITIVE_INFINITY, 4],
  ])('maps R=%s to tier %s', (r, tier) => {
    expect(retentionTier(r)).toBe(tier);
  });

  it('property: every number maps to one integer tier in the scale', () => {
    fc.assert(fc.property(fc.double(), (r) => {
      const tier = retentionTier(r);
      expect(Number.isInteger(tier)).toBe(true);
      expect(tier).toBeGreaterThanOrEqual(0);
      expect(tier).toBeLessThanOrEqual(4);
    }));
  });

  it('property: tiers are monotonic for every ordered R, including clamped outliers and infinities', () => {
    // NaN has no order and its own fallback; everything else must keep the order.
    const ordered = fc.oneof(fc.double({ noNaN: true }), fc.double({ min: -1, max: 2, noNaN: true }));
    fc.assert(fc.property(ordered, ordered, (a, b) => {
      expect(retentionTier(Math.min(a, b))).toBeLessThanOrEqual(retentionTier(Math.max(a, b)));
    }));
  });

  it.each(['red', 'yellow'] as const)('%s uses retention directly without changing state or counters', (color) => {
    const n = node({ id: 'a.ts', color, R: 0.45 });
    const before = structuredClone(n);
    expect(cellTone(n)).toEqual({ kind: 'scale', tier: 2 });
    expect(n).toEqual(before);
    expect(colorCounts(n)).toEqual({ red: color === 'red' ? 1 : 0, yellow: color === 'yellow' ? 1 : 0, green: 0, grey: 0 });
    expect(cellTone(node({ id: 'a.ts', color, R: null }))).toEqual({ kind: 'scale', tier: 0 });
  });

  it('property: green uses retention with a minimum tier of 3', () => {
    fc.assert(fc.property(fc.oneof(fc.double(), fc.constant(null)), (R) => {
      const tone = cellTone(node({ id: 'a.ts', color: 'green', R }));
      expect(tone).toEqual({ kind: 'scale', tier: Math.max(retentionTier(R ?? 0), 3) });
    }));
  });

  it('property: grey is always outside the scale', () => {
    fc.assert(fc.property(fc.oneof(fc.double(), fc.constant(null)), (R) => {
      expect(cellTone(node({ id: 'a.ts', color: 'grey', R }))).toEqual({ kind: 'none' });
    }));
  });
});

describe('statusStats', () => {
  const status: StatusJson = {
    version: 1,
    generatedAt: '2026-10-14T12:00:00.000Z',
    scanned: true,
    chunks: 12,
    leaves: 8,
    colors: { red: 2, yellow: 1, green: 3, grey: 2 },
    due: 2,
    questions: 24,
  };

  it('derives all four stats using all leaves as the percentage denominator', () => {
    const before = structuredClone(status);
    expect(statusStats(status)).toEqual({ leaves: 8, greenPercent: 37.5, dueNow: 2, questions: 24 });
    expect(status).toEqual(before);
  });

  it.each([false, true])('returns zero stats for an empty repo (scanned=%s)', (scanned) => {
    expect(statusStats({ ...status, scanned, chunks: 0, leaves: 0, colors: { red: 0, yellow: 0, green: 0, grey: 0 }, due: 0, questions: 0 }))
      .toEqual({ leaves: 0, greenPercent: 0, dueNow: 0, questions: 0 });
  });
});

describe('legend ranges and navigation', () => {
  it('labels each tier with the R range its bucket covers', () => {
    expect([0, 1, 2, 3, 4].map((t) => tierRange(t as 0 | 1 | 2 | 3 | 4))).toEqual(['0–19%', '20–39%', '40–59%', '60–79%', '80–100%']);
  });

  it('goes up from the container on screen: a parent for a container, the grandparent for a leaf', () => {
    const root = sampleMap().root;
    expect(upFrom(pathTo(root, '.'))).toBeUndefined();
    expect(upFrom([])).toBeUndefined();
    expect(upFrom(pathTo(root, 'src'))?.id).toBe('.');
    expect(upFrom(pathTo(root, 'src/math.ts'))?.id).toBe('src');
    // A selected leaf is shown inside src/math.ts, so up leaves that container.
    expect(upFrom(pathTo(root, 'src/math.ts#clamp'))?.id).toBe('src');
    // A top-level leaf is shown inside the root: there is nothing above.
    expect(upFrom(pathTo(root, 'app.py'))).toBeUndefined();
  });
});

describe('model', () => {
  const root = sampleMap().root;

  it('finds nodes and the breadcrumb trail', () => {
    expect(findNode(root, 'src/math.ts#mean')?.loc).toBe(18);
    expect(findNode(root, 'nope')).toBeNull();
    expect(pathTo(root, 'src/math.ts#mean').map((n) => n.id)).toEqual(['.', 'src', 'src/math.ts', 'src/math.ts#mean']);
    expect(pathTo(root, 'nope')).toEqual([]);
  });

  it('falls back to the closest surviving ancestor', () => {
    expect(closestExisting(root, 'src/math.ts#gone').id).toBe('src/math.ts');
    expect(closestExisting(root, 'src/deleted/x.ts').id).toBe('src');
    expect(closestExisting(root, 'elsewhere.ts').id).toBe('.');
  });

  it('counts leaves per colour like the CLI legend', () => {
    expect(colorCounts(root)).toEqual({ red: 1, yellow: 0, green: 1, grey: 3 });
    expect(colorCounts(findNode(root, 'src/math.ts')!)).toEqual({ red: 1, yellow: 0, green: 1, grey: 0 });
  });

  it('round-trips ids through the URL hash, including # and spaces', () => {
    expect(hashFor('.')).toBe('#/');
    expect(hashFor('src/auth/session.ts')).toBe('#/src/auth/session.ts');
    for (const id of ['.', 'src/auth/session.ts', 'src/a.ts#Store.refresh', 'src/my file.ts#~group:clamp', 'ü/ß.py']) {
      expect(idFromHash(hashFor(id))).toBe(id);
    }
    expect(idFromHash('')).toBe('.');
    expect(idFromHash('#/%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('formats R and due dates', () => {
    expect(formatR(null)).toBe('–');
    expect(formatR(Number.NaN)).toBe('–');
    expect(formatR(Number.POSITIVE_INFINITY)).toBe('–');
    expect(formatR(0.854)).toBe('85%');
    const now = new Date('2026-10-14T12:00:00Z');
    expect(formatDue(null, now)).toBe('–');
    expect(formatDue('garbage', now)).toBe('–');
    expect(formatDue('2026-11-01T00:00:00.000Z', now)).toBe('2026-11-01');
    expect(formatDue('2026-10-01T00:00:00.000Z', now)).toBe('2026-10-01 (due now)');
  });

  it('builds copyable commands: quiz for leaves, generate for grey leaves, nothing for parents', () => {
    expect(commandsFor(findNode(root, 'src/math.ts#clamp')!).map((c) => c.command)).toEqual(["gotchea quiz 'src/math.ts#clamp'"]);
    expect(commandsFor(findNode(root, 'src/util.ts')!).map((c) => c.command)).toEqual([
      'gotchea quiz src/util.ts',
      'gotchea generate --chunk src/util.ts',
    ]);
    expect(commandsFor(findNode(root, 'src')!)).toEqual([]);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('treats a root without chunks or code as empty', () => {
    expect(isEmptyMap(root)).toBe(false);
    expect(isEmptyMap(node({ id: '.', children: [], isLeaf: false }))).toBe(true);
    expect(isEmptyMap(node({ id: '.', children: [node({ id: 'a.ts', loc: 0 })] }))).toBe(true);
  });
});
