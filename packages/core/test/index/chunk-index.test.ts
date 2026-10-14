import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ChunkIndex } from '../../src/index/chunk-index.js';
import type { Chunk } from '../../src/model/chunk.js';

const c = (id: string, kind: Chunk['kind'], parentId: string | null, ranges: [number, number][], path = 'src/a.ts', isLeaf = true): Chunk => ({
  id,
  kind,
  parentId,
  title: id,
  source: 'code',
  ranges: ranges.map(([start, end]) => ({ path, start, end })),
  contentHash: '0000000000000000',
  metrics: { loc: 1, complexity: 1, fanIn: 0 },
  questionCount: isLeaf ? 3 : 0,
  isLeaf,
});

const chunks: Chunk[] = [
  c('.', 'module', null, [], '', false),
  c('src', 'module', '.', [], '', false),
  c('src/a.ts', 'file', 'src', [[1, 400]], 'src/a.ts', false),
  c('src/a.ts#Big', 'symbol', 'src/a.ts', [[10, 350]], 'src/a.ts', false),
  c('src/a.ts#Big.m1', 'symbol', 'src/a.ts#Big', [[20, 120]]),
  c('src/a.ts#Big.~group:m2', 'group', 'src/a.ts#Big', [[121, 130], [135, 140]]),
  c('src/a.ts#Big.~body', 'symbol', 'src/a.ts#Big', [[10, 19], [141, 350]]),
  c('src/a.ts#~top', 'symbol', 'src/a.ts', [[1, 5], [360, 400]]),
  c('src/b.ts', 'file', 'src', [[1, 50]], 'src/b.ts'),
];

describe('ChunkIndex', () => {
  const idx = new ChunkIndex(chunks);

  it('finds the deepest chunk containing a line', () => {
    expect(idx.lookup('src/a.ts', 50)?.id).toBe('src/a.ts#Big.m1');
    expect(idx.lookup('src/a.ts', 121)?.id).toBe('src/a.ts#Big.~group:m2');
    expect(idx.lookup('src/a.ts', 137)?.id).toBe('src/a.ts#Big.~group:m2');
    expect(idx.lookup('src/a.ts', 12)?.id).toBe('src/a.ts#Big.~body');
    expect(idx.lookup('src/a.ts', 3)?.id).toBe('src/a.ts#~top');
    expect(idx.lookup('src/b.ts', 7)?.id).toBe('src/b.ts');
  });

  it('falls back to the closest container for lines between leaves', () => {
    expect(idx.lookup('src/a.ts', 132)?.id).toBe('src/a.ts#Big');
    expect(idx.lookup('src/a.ts', 355)?.id).toBe('src/a.ts');
    expect(idx.lookup('src/a.ts', 9999)?.id).toBe('src/a.ts');
    expect(idx.lookup('src/a.ts', 0)?.id).toBe('src/a.ts');
  });

  it('normalizes paths and returns undefined for unknown files', () => {
    expect(idx.lookup('./src/a.ts', 50)?.id).toBe('src/a.ts#Big.m1');
    expect(idx.lookup('src\\a.ts', 50)?.id).toBe('src/a.ts#Big.m1');
    expect(idx.lookup('nope.ts', 1)).toBeUndefined();
    expect(idx.fileChunk('./src/b.ts')?.id).toBe('src/b.ts');
  });

  it('exposes ids, children and leaves', () => {
    expect(idx.size).toBe(chunks.length);
    expect(idx.get('src')?.kind).toBe('module');
    expect(idx.children('src').map((x) => x.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(idx.children('src/b.ts')).toEqual([]);
    expect(idx.leavesUnder('src/a.ts').map((x) => x.id)).toEqual([
      'src/a.ts#Big.m1',
      'src/a.ts#Big.~group:m2',
      'src/a.ts#Big.~body',
      'src/a.ts#~top',
    ]);
    expect(idx.leavesUnder('src/b.ts').map((x) => x.id)).toEqual(['src/b.ts']);
    expect(idx.leavesUnder('missing')).toEqual([]);
  });

  it('does not import tree-sitter (fast cold start)', async () => {
    const src = await readFile(new URL('../../src/index/chunk-index.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/'\.\.\/model\//);
  });

  it('answers 20k-chunk lookups with p95 < 5 ms', () => {
    const many: Chunk[] = [c('.', 'module', null, [], '', false)];
    for (let f = 0; f < 400; f++) {
      const path = `src/m${f % 20}/f${f}.ts`;
      many.push(c(path, 'file', '.', [[1, 2000]], path, false));
      for (let s = 0; s < 49; s++) many.push(c(`${path}#s${s}`, 'symbol', path, [[s * 40 + 1, s * 40 + 39]], path));
    }
    expect(many.length).toBeGreaterThan(20_000);
    const t0 = performance.now();
    const big = new ChunkIndex(many);
    const buildMs = performance.now() - t0;
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const f = (i * 7919) % 400;
      const line = ((i * 104729) % 1999) + 1;
      const s = performance.now();
      const hit = big.lookup(`src/m${f % 20}/f${f}.ts`, line);
      samples.push(performance.now() - s);
      expect(hit).toBeDefined();
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThan(5);
    // §7 only bounds lookups; the build bound is a loose sanity check so parallel CI load can't flake it.
    expect(buildMs).toBeLessThan(500);
  });
});
