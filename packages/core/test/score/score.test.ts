import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import type { Progress } from '../../src/model/progress.js';
import { computeTreeStates } from '../../src/score/aggregate.js';
import { addDays, daysUntil, elapsedDays, retrievability } from '../../src/score/retrievability.js';
import {
  aggregate,
  chunkState,
  colorFor,
  parentState,
  passThreshold,
  questionCount,
  selectionPriority,
} from '../../src/score/state.js';
import { emptyProgress, onContentChange, onSessionResult, type SessionResult } from '../../src/score/transitions.js';

const cfg = defaultConfig().score;
const bands = defaultConfig().questions;
const NOW = new Date('2026-10-14T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const result = (over: Partial<SessionResult> = {}): SessionResult => ({
  passed: true,
  at: NOW.toISOString(),
  hash: 'h1',
  sessionId: 's1',
  questionIds: ['q1', 'q2', 'q3'],
  correct: 3,
  total: 3,
  ...over,
});

const passed = (over: Partial<Progress> = {}): Progress => ({
  stability: 3,
  lastReviewedAt: daysAgo(0),
  lastPassedHash: 'h1',
  lastSeenHash: 'h1',
  mustRepass: false,
  history: [],
  ...over,
});

describe('retrievability', () => {
  it('is 1 at t = 0 and follows (1 + t/(9S))^-1', () => {
    expect(retrievability(3, 0, cfg)).toBe(1);
    expect(retrievability(3, 27, cfg)).toBeCloseTo(0.5, 12);
    expect(retrievability(1, 9, cfg)).toBeCloseTo(0.5, 12);
  });

  it('clamps negative elapsed time (clock skew) to 0', () => {
    expect(retrievability(3, -5, cfg)).toBe(1);
  });

  it('decreases in t and increases in S, staying within (0, 1]', () => {
    let prev = 1;
    for (let t = 1; t <= 1000; t *= 2) {
      const r = retrievability(3, t, cfg);
      expect(r).toBeLessThan(prev);
      expect(r).toBeGreaterThan(0);
      prev = r;
    }
    expect(retrievability(10, 30, cfg)).toBeGreaterThan(retrievability(3, 30, cfg));
  });

  it('daysUntil inverts retrievability', () => {
    const t = daysUntil(3, 0.85, cfg);
    expect(retrievability(3, t, cfg)).toBeCloseTo(0.85, 12);
  });

  it('elapsedDays and addDays use whole-day units', () => {
    expect(elapsedDays(daysAgo(2.5), NOW)).toBeCloseTo(2.5, 9);
    expect(addDays('2026-10-14T00:00:00.000Z', 1.5)).toBe('2026-10-15T12:00:00.000Z');
  });
});

describe('onSessionResult', () => {
  it('first pass sets S = initialStability and records the pass', () => {
    const p = onSessionResult(undefined, result(), cfg);
    expect(p).toMatchObject({ stability: 3, lastPassedHash: 'h1', lastSeenHash: 'h1', mustRepass: false, lastReviewedAt: NOW.toISOString() });
    expect(p.history).toEqual([
      { at: NOW.toISOString(), sessionId: 's1', questionIds: ['q1', 'q2', 'q3'], correct: 3, total: 3, passed: true, hash: 'h1' },
    ]);
  });

  it('later passes multiply S by 2.5', () => {
    const p1 = onSessionResult(undefined, result(), cfg);
    const p2 = onSessionResult(p1, result({ sessionId: 's2' }), cfg);
    const p3 = onSessionResult(p2, result({ sessionId: 's3' }), cfg);
    expect(p2.stability).toBe(7.5);
    expect(p3.stability).toBe(18.75);
    expect(p3.history).toHaveLength(3);
  });

  it('a pass with lastPassedHash set but null stability restarts at initialStability', () => {
    const p = onSessionResult(passed({ stability: null }), result(), cfg);
    expect(p.stability).toBe(3);
  });

  it('a fail before any pass leaves S at minStability and sets mustRepass', () => {
    const p = onSessionResult(undefined, result({ passed: false, correct: 1 }), cfg);
    expect(p).toMatchObject({ stability: 1, mustRepass: true, lastPassedHash: null, lastReviewedAt: NOW.toISOString() });
  });

  it('a fail multiplies S by 0.3, clamped at minStability', () => {
    expect(onSessionResult(passed({ stability: 10 }), result({ passed: false }), cfg).stability).toBe(3);
    expect(onSessionResult(passed({ stability: 2 }), result({ passed: false }), cfg).stability).toBe(1);
  });

  it('a pass after a fail is a later pass on the reduced S and clears mustRepass', () => {
    const failed = onSessionResult(passed({ stability: 10 }), result({ passed: false }), cfg);
    const p = onSessionResult(failed, result({ hash: 'h2' }), cfg);
    expect(p.stability).toBeCloseTo(7.5, 12);
    expect(p.mustRepass).toBe(false);
    expect(p.lastPassedHash).toBe('h2');
  });

  it('does not mutate its input', () => {
    const before = passed();
    const snapshot = structuredClone(before);
    onSessionResult(before, result({ passed: false }), cfg);
    expect(before).toEqual(snapshot);
  });
});

describe('onContentChange', () => {
  it('decays S by (1 - changeRatio) and records the new hash', () => {
    const p = onContentChange(passed({ stability: 10 }), 0.2, 'h2', cfg);
    expect(p.stability).toBeCloseTo(8, 12);
    expect(p.lastSeenHash).toBe('h2');
    expect(p.mustRepass).toBe(false);
  });

  it('applies the changeDecayFloor and minStability clamps', () => {
    expect(onContentChange(passed({ stability: 100 }), 0.95, 'h2', cfg).stability).toBeCloseTo(10, 12);
    expect(onContentChange(passed({ stability: 3 }), 1, 'h2', cfg).stability).toBe(1);
  });

  it('forces a re-pass only above redOnChangeRatio', () => {
    expect(onContentChange(passed(), 0.5, 'h2', cfg).mustRepass).toBe(false);
    expect(onContentChange(passed(), 0.51, 'h2', cfg).mustRepass).toBe(true);
    expect(onContentChange(passed({ mustRepass: true }), 0, 'h2', cfg).mustRepass).toBe(true);
  });

  it('clamps out-of-range ratios and keeps null stability', () => {
    expect(onContentChange(passed({ stability: 10 }), -1, 'h2', cfg).stability).toBe(10);
    expect(onContentChange(passed({ stability: 10 }), 7, 'h2', cfg)).toMatchObject({ stability: 1, mustRepass: true });
    expect(onContentChange(emptyProgress('h1'), 0.3, 'h2', cfg)).toMatchObject({ stability: null, lastSeenHash: 'h2' });
  });
});

describe('colorFor', () => {
  const flags = { neverPassed: false, mustRepass: false, hasQuestions: true };
  it('maps R to colors at the 0.5 / 0.85 thresholds', () => {
    expect(colorFor(0.85, flags, cfg)).toBe('green');
    expect(colorFor(0.849, flags, cfg)).toBe('yellow');
    expect(colorFor(0.5, flags, cfg)).toBe('yellow');
    expect(colorFor(0.499, flags, cfg)).toBe('red');
  });
  it('grey without questions, red when never passed, must re-pass or unknown R', () => {
    expect(colorFor(1, { ...flags, hasQuestions: false }, cfg)).toBe('grey');
    expect(colorFor(1, { ...flags, neverPassed: true }, cfg)).toBe('red');
    expect(colorFor(1, { ...flags, mustRepass: true }, cfg)).toBe('red');
    expect(colorFor(null, flags, cfg)).toBe('red');
    expect(colorFor(Number.NaN, flags, cfg)).toBe('red');
  });
});

describe('chunkState', () => {
  it('is grey with R = null when there are no ok questions', () => {
    expect(chunkState(0, passed(), NOW, cfg)).toEqual({ R: null, color: 'grey' });
  });
  it('is red with R = 0 when never passed', () => {
    expect(chunkState(5, undefined, NOW, cfg)).toEqual({ R: 0, color: 'red' });
    expect(chunkState(5, onSessionResult(undefined, result({ passed: false }), cfg), NOW, cfg)).toEqual({ R: 0, color: 'red' });
    expect(chunkState(5, passed({ lastReviewedAt: null }), NOW, cfg)).toEqual({ R: 0, color: 'red' });
  });
  it('computes R from elapsed time and a dueAt when R reaches greenAt', () => {
    const s = chunkState(5, passed({ stability: 3, lastReviewedAt: daysAgo(27) }), NOW, cfg);
    expect(s.R).toBeCloseTo(0.5, 12);
    expect(s.color).toBe('yellow');
    expect(s.dueAt).toBe(addDays(daysAgo(27), daysUntil(3, 0.85, cfg)));
    expect(chunkState(5, passed({ lastReviewedAt: daysAgo(1) }), NOW, cfg).color).toBe('green');
    expect(chunkState(5, passed({ lastReviewedAt: daysAgo(200) }), NOW, cfg).color).toBe('red');
  });
  it('treats corrupt progress as never passed instead of throwing', () => {
    expect(chunkState(5, passed({ lastReviewedAt: 'yesterday' }), NOW, cfg)).toEqual({ R: 0, color: 'red' });
    expect(chunkState(5, passed({ stability: 0 }), NOW, cfg)).toEqual({ R: 0, color: 'red' });
    expect(chunkState(5, passed({ stability: -2 }), NOW, cfg)).toEqual({ R: 0, color: 'red' });
  });
  it('omits dueAt when it is not a representable date', () => {
    const s = chunkState(5, passed({ stability: Number.POSITIVE_INFINITY, lastReviewedAt: daysAgo(1) }), NOW, cfg);
    expect(s).toEqual({ R: 1, color: 'green' });
    expect(addDays(daysAgo(1), Number.POSITIVE_INFINITY)).toBeNull();
    expect(addDays('not a date', 1)).toBeNull();
  });
  it('is red while mustRepass is set even with high R', () => {
    expect(chunkState(5, passed({ mustRepass: true }), NOW, cfg).color).toBe('red');
  });
});

describe('aggregate and parentState', () => {
  it('is the LOC-weighted mean, skipping grey children', () => {
    expect(aggregate([{ loc: 30, R: 1 }, { loc: 10, R: 0 }, { loc: 500, R: null }])).toBeCloseTo(0.75, 12);
  });
  it('is null when every child is grey or there are none', () => {
    expect(aggregate([])).toBeNull();
    expect(aggregate([{ loc: 10, R: null }])).toBeNull();
  });
  it('falls back to an unweighted mean when all weights are zero', () => {
    expect(aggregate([{ loc: 0, R: 1 }, { loc: -3, R: 0.5 }, { loc: 4, R: null }])).toBeCloseTo(0.75, 12);
  });
  it('parent colors come from the aggregated R only', () => {
    expect(parentState([{ loc: 1, R: null }], cfg)).toEqual({ R: null, color: 'grey' });
    expect(parentState([{ loc: 1, R: 0.9 }], cfg)).toEqual({ R: 0.9, color: 'green' });
    expect(parentState([{ loc: 1, R: 0.9 }, { loc: 1, R: 0 }], cfg)).toEqual({ R: 0.45, color: 'red' });
  });
});

describe('passThreshold', () => {
  it('is ceil(ratio * n) without float noise', () => {
    expect(passThreshold(3, 0.75)).toBe(3);
    expect(passThreshold(4, 0.75)).toBe(3);
    expect(passThreshold(5, 0.75)).toBe(4);
    expect(passThreshold(7, 0.75)).toBe(6);
    expect(passThreshold(10, 0.7)).toBe(7);
    expect(passThreshold(0, 0.75)).toBe(0);
  });
});

describe('questionCount', () => {
  it('uses the 3/5/7 bands by LOC and complexity', () => {
    expect(questionCount({ loc: 60, complexity: 8 }, bands)).toBe(3);
    expect(questionCount({ loc: 61, complexity: 1 }, bands)).toBe(5);
    expect(questionCount({ loc: 10, complexity: 9 }, bands)).toBe(5);
    expect(questionCount({ loc: 150, complexity: 20 }, bands)).toBe(5);
    expect(questionCount({ loc: 151, complexity: 1 }, bands)).toBe(7);
    expect(questionCount({ loc: 1, complexity: 21 }, bands)).toBe(7);
  });
  it('falls back to the last band when none matches, and 0 with no bands', () => {
    expect(questionCount({ loc: 999, complexity: 1 }, { bands: [{ maxLoc: 10, count: 2 }, { maxLoc: 20, count: 4 }] })).toBe(4);
    expect(questionCount({ loc: 1, complexity: 1 }, { bands: [] })).toBe(0);
  });
});

describe('selectionPriority', () => {
  it('is (1 - R)(1 + w ln(1 + fanIn)) with null R treated as 0', () => {
    expect(selectionPriority(null, 0, { fanInWeight: 0.5 })).toBe(1);
    expect(selectionPriority(0.5, Math.E - 1, { fanInWeight: 0.5 })).toBeCloseTo(0.75, 12);
    expect(selectionPriority(1, 100, { fanInWeight: 0.5 })).toBe(0);
    expect(selectionPriority(0, -4, { fanInWeight: 0.5 })).toBe(1);
  });
});

describe('computeTreeStates', () => {
  const m = (loc: number) => ({ loc, complexity: 1, fanIn: 0 });
  it('computes leaves from progress and parents by aggregation, bottom-up', () => {
    const chunks = [
      { id: '.', parentId: null, isLeaf: false, metrics: m(40) },
      { id: 'a.ts', parentId: '.', isLeaf: false, metrics: m(40) },
      { id: 'a.ts#x', parentId: 'a.ts', isLeaf: true, metrics: m(30) },
      { id: 'a.ts#y', parentId: 'a.ts', isLeaf: true, metrics: m(10) },
      { id: 'empty', parentId: '.', isLeaf: false, metrics: m(0) },
    ];
    const states = computeTreeStates({
      chunks,
      okQuestions: new Map([['a.ts#x', 6]]),
      progress: { 'a.ts#x': passed({ lastReviewedAt: daysAgo(0) }) },
      now: NOW,
      cfg,
    });
    expect(states.get('a.ts#x')).toMatchObject({ R: 1, color: 'green' });
    expect(states.get('a.ts#y')).toEqual({ R: null, color: 'grey' });
    expect(states.get('a.ts')).toEqual({ R: 1, color: 'green' });
    // A non-leaf with no children is treated like a leaf without questions.
    expect(states.get('empty')).toEqual({ R: null, color: 'grey' });
    expect(states.get('.')).toEqual({ R: 1, color: 'green' });
  });
});
