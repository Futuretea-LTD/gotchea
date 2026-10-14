import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import type { Chunk, ChunksFile } from '../../src/model/chunk.js';
import type { Progress, ProgressFile } from '../../src/model/progress.js';
import type { QuestionPrivate } from '../../src/model/question.js';
import { carryAliases, computeScanDiff } from '../../src/scan/diff.js';
import { applyScanDiff, reconcileProgress, reconcileSnapshotHashes } from '../../src/scan/reconcile.js';

const cfg = defaultConfig().score;

const chunk = (id: string, contentHash: string, extra: Partial<Chunk> = {}): Chunk => ({
  id,
  kind: 'symbol',
  parentId: 'f.ts',
  title: id,
  source: 'code',
  ranges: [],
  contentHash,
  metrics: { loc: 10, complexity: 1, fanIn: 0 },
  questionCount: 3,
  isLeaf: true,
  ...extra,
});

const file = (chunks: Chunk[], normalization = 'n1'): ChunksFile => ({ version: 1, normalization: normalization as 'n1', chunks });

const q = (id: string, chunkId: string, chunkHash: string, status: QuestionPrivate['status'] = 'ok'): QuestionPrivate => ({
  id,
  chunkId,
  chunkHash,
  type: 'behavior',
  stem: `stem ${id}`,
  options: ['a', 'b', 'c', 'd'],
  correctIndex: 0,
  explanation: '',
  refs: [],
  difficulty: 1,
  lang: 'en',
  generatedBy: 'test',
  status,
  flagged: false,
  chunkLines: 0,
  promptVersion: 'p1',
  verifiedBy: null,
  createdAt: '2026-10-14T00:00:00.000Z',
});

const prog = (lastSeenHash: string, over: Partial<Progress> = {}): Progress => ({
  stability: 10,
  lastReviewedAt: '2026-10-01T00:00:00.000Z',
  lastPassedHash: lastSeenHash,
  lastSeenHash,
  mustRepass: false,
  history: [],
  ...over,
});

const progressFile = (chunks: Record<string, Progress>): ProgressFile => ({ version: 1, repoId: 'r', chunks });

describe('computeScanDiff', () => {
  const prev = file([chunk('f.ts#a', 'h-a'), chunk('f.ts#b', 'h-b'), chunk('f.ts#gone', 'h-gone'), chunk('f.ts#old', 'h-move')]);
  const next = [chunk('f.ts#a', 'h-a'), chunk('f.ts#b', 'h-b2'), chunk('f.ts#new', 'h-new'), chunk('g.ts#moved', 'h-move')];
  const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `${tag}${i}`);

  it('classifies added, removed, unchanged, changed and moved chunks', () => {
    const d = computeScanDiff(prev, next, {
      old: new Map([['h-b', lines(10)]]),
      new: new Map([['f.ts#b', [...lines(7), 'x', 'y', 'z']]]),
    });
    expect(d.unchanged).toEqual(['f.ts#a']);
    expect(d.added).toEqual(['f.ts#new']);
    expect(d.removed).toEqual(['f.ts#gone']);
    expect(d.moved).toEqual([{ from: 'f.ts#old', to: 'g.ts#moved', kind: 'symbol', contentHash: 'h-move' }]);
    expect(d.changed).toEqual([{ id: 'f.ts#b', kind: 'symbol', oldHash: 'h-b', newHash: 'h-b2', changeRatio: 0.3 }]);
    expect(d.renormalized).toEqual([]);
  });

  it('uses changeRatio 1 without an old snapshot, and treats a missing prev as all-added', () => {
    expect(computeScanDiff(prev, next).changed[0]!.changeRatio).toBe(1);
    const d = computeScanDiff(null, next);
    expect(d.added).toEqual(['f.ts#a', 'f.ts#b', 'f.ts#new', 'g.ts#moved']);
    expect(d.moved).toEqual([]);
  });

  it('only pairs moves of the same kind, each target once', () => {
    const p = file([chunk('a#x', 'same'), chunk('a#y', 'same'), chunk('dir', 'same', { kind: 'module' })]);
    const d = computeScanDiff(p, [chunk('b#x', 'same'), chunk('dir2', 'same', { kind: 'file' })]);
    expect(d.moved).toEqual([{ from: 'a#x', to: 'b#x', kind: 'symbol', contentHash: 'same' }]);
    expect(d.removed).toEqual(['a#y', 'dir']);
    expect(d.added).toEqual(['dir2']);
  });

  it('prefers the same symbol path when several moves share a hash, and never pairs empty chunks', () => {
    const empty = { kind: 'file' as const, metrics: { loc: 0, complexity: 1, fanIn: 0 } };
    const p = file([chunk('a.py#A.__init__', 'init'), chunk('a.py#B.__init__', 'init'), chunk('pkg/a/__init__.py', 'empty', empty)]);
    const d = computeScanDiff(p, [chunk('b.py#C.__init__', 'init'), chunk('b.py#B.__init__', 'init'), chunk('pkg/b/__init__.py', 'empty', empty)]);
    expect(d.moved.map((m) => [m.from, m.to])).toEqual([
      ['a.py#A.__init__', 'b.py#C.__init__'],
      ['a.py#B.__init__', 'b.py#B.__init__'],
    ]);
    expect(d.removed).toEqual(['pkg/a/__init__.py']);
    expect(d.added).toEqual(['pkg/b/__init__.py']);
  });

  it('reports hash changes after a normalization bump as renormalized, without decay', () => {
    const d = computeScanDiff(file([chunk('f.ts#a', 'old')], 'n0'), [chunk('f.ts#a', 'new')]);
    expect(d.changed).toEqual([]);
    expect(d.renormalized).toEqual([{ id: 'f.ts#a', kind: 'symbol', oldHash: 'old', newHash: 'new', changeRatio: 0 }]);
  });
});

describe('carryAliases', () => {
  it('keeps aliases of unchanged ids, prepends moved-from ids and caps at 5', () => {
    const prev = file([chunk('keep', 'k', { aliases: ['k0'] }), chunk('old', 'm', { aliases: ['a1', 'a2', 'a3', 'a4', 'a5'] })]);
    const out = carryAliases(prev, [chunk('keep', 'k2'), chunk('new', 'm'), chunk('fresh', 'f', { aliases: ['stale'] })], [
      { from: 'old', to: 'new', kind: 'symbol', contentHash: 'm' },
    ]);
    expect(out[0]!.aliases).toEqual(['k0']);
    expect(out[1]!.aliases).toEqual(['old', 'a1', 'a2', 'a3', 'a4']);
    expect(out[2]).not.toHaveProperty('aliases');
    expect(carryAliases(null, [chunk('x', 'x')], [])[0]).not.toHaveProperty('aliases');
  });
});

describe('applyScanDiff', () => {
  it('marks ok questions of changed chunks stale and decays progress by changeRatio', () => {
    const diff = computeScanDiff(file([chunk('c', 'h1')]), [chunk('c', 'h2')], {
      old: new Map([['h1', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']]]),
      new: new Map([['c', ['1', '2', '3', '4', '5', '6', '7', '8', 'x', 'y']]]),
    });
    const questions = new Map([['c', [q('q1', 'c', 'h1'), { ...q('q2', 'c', 'h1', 'stale'), flagged: true }, q('q3', 'c', 'h2')]]]);
    const input = { diff, questions, progress: progressFile({ c: prog('h1') }), cfg };
    const r = applyScanDiff(input);
    expect(r.staleCount).toBe(1);
    expect(r.questions.get('c')!.map((x) => x.status)).toEqual(['stale', 'stale', 'ok']);
    expect(r.progress.chunks['c']).toMatchObject({ stability: 8, lastSeenHash: 'h2', mustRepass: false });
    expect(r.decayed).toEqual([{ id: 'c', fromHash: 'h1', toHash: 'h2', changeRatio: 0.2 }]);
    // Pure: inputs untouched.
    expect(questions.get('c')![0]!.status).toBe('ok');
    expect(input.progress.chunks['c']!.stability).toBe(10);
  });

  it('leaves progress alone when the user last saw a different hash (reconcile handles it)', () => {
    const diff = computeScanDiff(file([chunk('c', 'h1')]), [chunk('c', 'h2')]);
    const r = applyScanDiff({ diff, questions: new Map(), progress: progressFile({ c: prog('h0') }), cfg });
    expect(r.progress.chunks['c']).toEqual(prog('h0'));
    expect(r.questions.has('c')).toBe(false);
    expect(r.decayed).toEqual([]);
  });

  it('applies the decay floor and forces a re-pass on big rewrites', () => {
    const diff = computeScanDiff(file([chunk('c', 'h1')]), [chunk('c', 'h2')]);
    const r = applyScanDiff({ diff, questions: new Map(), progress: progressFile({ c: prog('h1', { stability: 50 }) }), cfg });
    expect(r.progress.chunks['c']).toMatchObject({ stability: 5, mustRepass: true });
  });

  it('moves pools and progress, merges with an existing destination pool and deletes removed pools', () => {
    const diff = computeScanDiff(file([chunk('old', 'm'), chunk('gone', 'g')]), [chunk('new', 'm')]);
    const r = applyScanDiff({
      diff,
      questions: new Map([
        ['old', [q('q1', 'old', 'm'), q('q2', 'old', 'm')]],
        ['new', [q('q2', 'new', 'm')]],
        ['gone', [q('q9', 'gone', 'g')]],
      ]),
      progress: progressFile({ old: prog('m'), gone: prog('g') }),
      cfg,
    });
    expect(r.questions.get('new')!.map((x) => [x.id, x.chunkId])).toEqual([
      ['q2', 'new'],
      ['q1', 'new'],
    ]);
    expect(r.questions.get('old')).toEqual([]);
    expect(r.questions.get('gone')).toEqual([]);
    expect(Object.keys(r.progress.chunks).sort()).toEqual(['gone', 'new']);
  });

  it('keeps destination progress on a move', () => {
    const diff = computeScanDiff(file([chunk('old', 'm')]), [chunk('new', 'm')]);
    const r = applyScanDiff({ diff, questions: new Map(), progress: progressFile({ old: prog('m', { stability: 1 }), new: prog('m') }), cfg });
    expect(r.progress.chunks['new']!.stability).toBe(10);
    expect(r.progress.chunks['old']).toBeUndefined();
  });

  it('rewrites hashes for renormalized chunks without staling or decaying', () => {
    const diff = computeScanDiff(file([chunk('c', 'old')], 'n0'), [chunk('c', 'new')]);
    const r = applyScanDiff({
      diff,
      questions: new Map([['c', [q('q1', 'c', 'old'), q('q2', 'c', 'other')]]]),
      progress: progressFile({ c: prog('old'), d: prog('x') }),
      cfg,
    });
    expect(r.staleCount).toBe(0);
    expect(r.questions.get('c')!.map((x) => x.chunkHash)).toEqual(['new', 'other']);
    expect(r.progress.chunks['c']).toMatchObject({ stability: 10, lastSeenHash: 'new', lastPassedHash: 'new' });
    const keepPassed = applyScanDiff({ diff, questions: new Map(), progress: progressFile({ c: prog('old', { lastPassedHash: 'older' }) }), cfg });
    expect(keepPassed.progress.chunks['c']!.lastPassedHash).toBe('older');
    expect(keepPassed.questions.has('c')).toBe(false);
    const unseen = applyScanDiff({ diff, questions: new Map(), progress: progressFile({ c: prog('older') }), cfg });
    expect(unseen.progress.chunks['c']!.lastSeenHash).toBe('older');
  });
});

describe('reconcileProgress', () => {
  it('decays entries whose lastSeenHash differs, using the stored snapshot', () => {
    const r = reconcileProgress({
      chunks: [chunk('c', 'h2'), chunk('same', 's'), chunk('none', 'n')],
      progress: progressFile({ c: prog('h1'), same: prog('s') }),
      oldFingerprints: new Map([['h1', ['a', 'b', 'c', 'd']]]),
      newFingerprints: new Map([['c', ['a', 'b', 'c', 'X']]]),
      cfg,
    });
    expect(r.changes).toEqual([{ id: 'c', fromHash: 'h1', toHash: 'h2', changeRatio: 0.25 }]);
    expect(r.progress.chunks['c']).toMatchObject({ stability: 7.5, lastSeenHash: 'h2' });
    expect(r.progress.chunks['same']).toEqual(prog('s'));
  });

  it('is pessimistic without a snapshot and migrates entries stored under an alias', () => {
    const r = reconcileProgress({
      chunks: [chunk('new', 'h2', { aliases: ['missing', 'old'] })],
      progress: progressFile({ old: prog('h1') }),
      oldFingerprints: new Map(),
      newFingerprints: new Map(),
      cfg,
    });
    expect(r.progress.chunks['old']).toBeUndefined();
    expect(r.progress.chunks['new']).toMatchObject({ stability: 1, mustRepass: true, lastSeenHash: 'h2' });
    expect(r.changes[0]!.changeRatio).toBe(1);
  });

  it('lists the snapshot hashes it needs', () => {
    const chunks = [chunk('a', 'h2'), chunk('b', 'x', { aliases: ['b0'] }), chunk('c', 'c'), chunk('d', 'd')];
    expect(reconcileSnapshotHashes(chunks, progressFile({ a: prog('h1'), b0: prog('h0'), c: prog('c') }))).toEqual(['h0', 'h1']);
  });
});
