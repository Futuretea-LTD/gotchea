import { describe, expect, it } from 'vitest';
import type { Chunk } from '../../src/model/chunk.js';
import { buildMapTree, filterTree, matchesFilter } from '../../src/map/tree.js';

const chunk = (id: string, kind: Chunk['kind'], parentId: string | null, path: string, start = 1, isLeaf = false): Chunk => ({
  id,
  kind,
  parentId,
  title: id,
  source: 'code',
  ranges: kind === 'module' ? [] : [{ path, start, end: start + 4 }],
  contentHash: id,
  metrics: { loc: 5, complexity: 1, fanIn: 0 },
  questionCount: isLeaf ? 3 : 0,
  isLeaf,
});

const chunks = [
  chunk('.', 'module', null, ''),
  chunk('src', 'module', '.', ''),
  chunk('src/a.ts', 'file', 'src', 'src/a.ts'),
  chunk('src/a.ts#zed', 'symbol', 'src/a.ts', 'src/a.ts', 20, true),
  chunk('src/a.ts#alpha', 'symbol', 'src/a.ts', 'src/a.ts', 2, true),
  chunk('src/b.ts', 'file', 'src', 'src/b.ts', 1, true),
];

describe('buildMapTree', () => {
  const root = buildMapTree(chunks, new Map([['src/b.ts', { R: 0.9, color: 'green' as const, dueAt: '2026-01-01T00:00:00.000Z' }]]), new Map([['src/b.ts', 2]]))!;

  it('nests by parent and orders files before symbols, symbols by line', () => {
    const src = root.children[0]!;
    expect(src.children.map((c) => c.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(src.children[0]!.children.map((c) => c.id)).toEqual(['src/a.ts#alpha', 'src/a.ts#zed']);
  });

  it('carries path, lines, counts and state; defaults to grey', () => {
    const [a, b] = root.children[0]!.children;
    expect(root.path).toBeNull();
    expect(a!.children[0]).toMatchObject({ path: 'src/a.ts', lines: { start: 2, end: 6 }, questionCount: 3, okQuestions: 0, state: { color: 'grey', R: null, dueAt: null } });
    expect(a!.lines).toBeNull();
    expect(b).toMatchObject({ okQuestions: 2, loc: 5, state: { color: 'green', R: 0.9, dueAt: '2026-01-01T00:00:00.000Z' } });
  });

  it('is null without a root chunk', () => {
    expect(buildMapTree([], new Map(), new Map())).toBeNull();
  });
});

describe('matchesFilter / filterTree', () => {
  it('matches the id itself, descendants, and everything for "."', () => {
    expect(matchesFilter('src/a.ts', '.')).toBe(true);
    expect(matchesFilter('src/a.ts#x', 'src/a.ts')).toBe(true);
    expect(matchesFilter('src/a.ts', 'src')).toBe(true);
    expect(matchesFilter('srcx/a.ts', 'src')).toBe(false);
    expect(matchesFilter('src/a.ts#f.g', 'src/a.ts#f')).toBe(true);
    expect(matchesFilter('src/a.ts#fx', 'src/a.ts#f')).toBe(false);
  });

  it('keeps matching subtrees plus ancestors, null when nothing matches', () => {
    const root = buildMapTree(chunks, new Map(), new Map())!;
    const kept = filterTree(root, 'src/a.ts')!;
    expect(kept.children.map((c) => c.id)).toEqual(['src']);
    expect(kept.children[0]!.children.map((c) => c.id)).toEqual(['src/a.ts']);
    expect(filterTree(root, 'nope')).toBeNull();
  });
});
