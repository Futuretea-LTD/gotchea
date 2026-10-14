import { describe, expect, it } from 'vitest';
import type { ChunkDraft } from '../../src/chunk/chunker.js';
import {
  assignSegments,
  buildFileDraft,
  draftSymbolPaths,
  groupSiblings,
  mergeAdjacent,
  remainderRanges,
  sanitizeSegment,
  type DraftContext,
} from '../../src/chunk/grouping.js';
import { defaultConfig } from '../../src/config/load.js';
import type { SymbolNode } from '../../src/parse/parser.js';

const cfg = defaultConfig().chunking;

/** A synthetic file: `n` lines, each with unique content unless listed in `blank`. */
function ctx(n: number, blank: number[] = [], overrides: Partial<DraftContext> = {}): DraftContext {
  const fileLines = Array.from({ length: n }, (_, i) => (blank.includes(i + 1) ? '' : `line ${i + 1}`));
  return { path: 'src/f.ts', fileLines, complexity: () => 1, cfg, ...overrides };
}

const sym = (name: string, start: number, end: number, children: SymbolNode[] = []): SymbolNode => ({
  name,
  kind: 'function',
  start,
  end,
  children,
});

const leaf = (name: string, loc: number): ChunkDraft => ({
  kind: 'symbol',
  symbolPath: [name],
  title: name,
  ranges: [{ path: 'f', start: 1, end: loc }],
  normalizedLines: Array.from({ length: loc }, (_, i) => `${name}${i}`),
  complexity: 2,
  children: [],
});

const shape = (d: ChunkDraft): unknown => ({
  path: d.symbolPath.join('.'),
  kind: d.kind,
  loc: d.normalizedLines.length,
  ...(d.children.length ? { children: d.children.map(shape) } : {}),
});

describe('buildFileDraft', () => {
  it('keeps files up to leafMaxLoc as a single leaf', () => {
    const d = buildFileDraft(ctx(200), [sym('a', 1, 100), sym('b', 101, 200)], 'typescript');
    expect(d).toMatchObject({ kind: 'file', symbolPath: [], title: 'f.ts', lang: 'typescript', children: [] });
    expect(d.normalizedLines).toHaveLength(200);
    expect(d.ranges).toEqual([{ path: 'src/f.ts', start: 1, end: 200 }]);
  });

  it('splits larger files into symbols, groups of small siblings and ~top', () => {
    const symbols = [
      sym('imports', 1, 1), // not a symbol in practice; here: small sibling
      sym('a', 3, 12), // 10
      sym('b', 13, 22), // 10
      sym('c', 23, 32), // 10
      sym('d', 33, 42), // 10 -> group a..d reaches 40
      sym('e', 43, 52), // 10 -> next group e alone, then big breaks it
      sym('big', 53, 200), // 148
      sym('f', 201, 210), // 10
      sym('g', 211, 220), // 10
    ];
    const d = buildFileDraft(ctx(230, [2]), symbols.slice(1));
    expect(d.children.map(shape)).toEqual([
      { path: '~group:a', kind: 'group', loc: 40 },
      { path: 'e', kind: 'symbol', loc: 10 },
      { path: 'big', kind: 'symbol', loc: 148 },
      { path: '~group:f', kind: 'group', loc: 20 },
      { path: '~top', kind: 'symbol', loc: 11 },
    ]);
    const top = d.children[4]!;
    expect(top.ranges).toEqual([
      { path: 'src/f.ts', start: 1, end: 1 },
      { path: 'src/f.ts', start: 221, end: 230 },
    ]);
    const group = d.children[0]!;
    expect(group.members).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(group.ranges).toEqual([{ path: 'src/f.ts', start: 3, end: 42 }]);
    expect(group.title).toBe('a … d (4)');
  });

  it('splits symbols above splitAboveLoc into sub-symbols plus ~body, recursively', () => {
    const methods = [sym('m1', 5, 104), sym('m2', 105, 304), sym('tiny', 305, 306)];
    const d = buildFileDraft(ctx(320), [sym('Big', 1, 310, methods)]);
    expect(d.children.map(shape)).toEqual([
      {
        path: 'Big',
        kind: 'symbol',
        loc: 310,
        children: [
          { path: 'Big.m1', kind: 'symbol', loc: 100 },
          { path: 'Big.m2', kind: 'symbol', loc: 200 },
          { path: 'Big.tiny', kind: 'symbol', loc: 2 },
          { path: 'Big.~body', kind: 'symbol', loc: 8 },
        ],
      },
      { path: '~top', kind: 'symbol', loc: 10 },
    ]);
    expect(d.children[0]!.children[3]!.title).toBe('Big (body)');
  });

  it('keeps an oversized symbol without sub-symbols as a leaf', () => {
    const d = buildFileDraft(ctx(400), [sym('huge', 1, 400)]);
    // A single leaf child would duplicate the file, so the file stays the leaf.
    expect(d.children).toEqual([]);
  });

  it('keeps a lone non-leaf child', () => {
    const d = buildFileDraft(ctx(400), [sym('Huge', 1, 400, [sym('a', 2, 200), sym('b', 201, 399)])]);
    expect(d.children.map((c) => c.symbolPath.join('.'))).toEqual(['Huge']);
    expect(d.children[0]!.children.map((c) => c.symbolPath.join('.'))).toEqual(['Huge.a', 'Huge.b', 'Huge.~body']);
  });

  it('sums complexity of group members and remainder ranges as 1 + decisions', () => {
    const complexity = (s: number, e: number) => 1 + (e - s + 1 >= 10 ? 2 : 0);
    const d = buildFileDraft(ctx(250, [], { complexity }), [sym('a', 1, 10), sym('b', 11, 20), sym('big', 21, 230)]);
    expect(d.children[0]).toMatchObject({ kind: 'group', complexity: 5 });
    expect(d.children.at(-1)).toMatchObject({ symbolPath: ['~top'], complexity: 3 });
  });

  it('handles an empty file', () => {
    const d = buildFileDraft({ path: 'e.ts', fileLines: [''], complexity: () => 1, cfg }, []);
    expect(d).toMatchObject({ normalizedLines: [], children: [], ranges: [{ path: 'e.ts', start: 1, end: 1 }] });
  });
});

describe('groupSiblings', () => {
  it('stops a group at leafMaxLoc and never groups non-small or non-leaf drafts', () => {
    const small = { ...cfg, mergeBelowLoc: 15, leafMinLoc: 40, leafMaxLoc: 25 };
    const out = groupSiblings([leaf('a', 14), leaf('b', 10), leaf('c', 14), leaf('d', 15)], small, []);
    expect(out.map((d) => d.symbolPath.join('.'))).toEqual(['~group:a', 'c', 'd']);
    const parent = { ...leaf('p', 3), children: [leaf('x', 1)] };
    expect(groupSiblings([leaf('a', 3), parent, leaf('b', 3)], cfg, ['Cls']).map((d) => d.symbolPath.join('.'))).toEqual(['a', 'p', 'b']);
  });

  it('prefixes nested group ids with the parent symbol path', () => {
    const out = groupSiblings([leaf('a', 3), leaf('b', 3)].map((d) => ({ ...d, symbolPath: ['Cls', d.symbolPath[0]!] })), cfg, ['Cls']);
    expect(out[0]!.symbolPath).toEqual(['Cls', '~group:a']);
    expect(out[0]!.complexity).toBe(3);
  });
});

describe('helpers', () => {
  it('assignSegments numbers duplicates in source order', () => {
    expect(assignSegments([{ name: 'f' }, { name: 'g' }, { name: 'f' }, { name: 'f' }])).toEqual(['f', 'g', 'f@2', 'f@3']);
  });

  it('sanitizeSegment removes id separators', () => {
    expect(sanitizeSegment('[Symbol.iterator]')).toBe('[Symbol_iterator]');
    expect(sanitizeSegment('a #b')).toBe('a_b');
    expect(sanitizeSegment('')).toBe('_');
  });

  it('mergeAdjacent joins touching ranges of the same path only', () => {
    expect(
      mergeAdjacent([
        { path: 'a', start: 1, end: 3 },
        { path: 'a', start: 4, end: 6 },
        { path: 'a', start: 8, end: 9 },
        { path: 'b', start: 10, end: 11 },
      ]),
    ).toEqual([
      { path: 'a', start: 1, end: 6 },
      { path: 'a', start: 8, end: 9 },
      { path: 'b', start: 10, end: 11 },
    ]);
  });

  it('remainderRanges absorbs blank lines and breaks at covered lines', () => {
    const lines = ['a', '', 'b', 'x', 'x', '', 'c', ''];
    expect(remainderRanges({ start: 1, end: 8 }, [{ start: 4, end: 5 }], lines)).toEqual([
      { start: 1, end: 3 },
      { start: 7, end: 7 },
    ]);
    expect(remainderRanges({ start: 1, end: 3 }, [{ start: 1, end: 3 }], lines)).toEqual([]);
  });

  it('draftSymbolPaths strips duplicate suffixes and expands groups', () => {
    expect(draftSymbolPaths({ ...leaf('f@2', 1), symbolPath: ['C', 'f@2'] })).toEqual([['C', 'f']]);
    expect(draftSymbolPaths({ ...leaf('g', 1), members: [['a'], ['b@3']] })).toEqual([['a'], ['b']]);
  });
});
