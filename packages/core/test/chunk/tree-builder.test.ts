import { describe, expect, it } from 'vitest';
import type { FileDraft } from '../../src/chunk/chunker.js';
import { buildFanIn } from '../../src/chunk/fanin.js';
import { buildFileDraft } from '../../src/chunk/grouping.js';
import { buildTree, type BuiltFile } from '../../src/chunk/tree-builder.js';
import { defaultConfig } from '../../src/config/load.js';
import { contentHash, moduleHash } from '../../src/hash/hash.js';
import type { SymbolNode } from '../../src/parse/parser.js';

const cfg = defaultConfig();

function file(path: string, n: number, symbols: SymbolNode[] = []): BuiltFile {
  const fileLines = Array.from({ length: n }, (_, i) => `${path}:${i + 1}`);
  const draft: FileDraft = buildFileDraft({ path, fileLines, complexity: (s, e) => 1 + Math.floor((e - s) / 50), cfg: cfg.chunking }, symbols, 'typescript');
  return { path, source: 'code', draft };
}

const fn = (name: string, start: number, end: number): SymbolNode => ({ name, kind: 'function', start, end, children: [] });

describe('buildTree', () => {
  const files = [file('src/auth/session.ts', 300, [fn('refresh', 1, 150), fn('revoke', 151, 290)]), file('src/a.ts', 10), file('README.ts', 3)];
  const { chunks, lines } = buildTree(files, cfg, { rootTitle: 'repo' });
  const byId = new Map(chunks.map((c) => [c.id, c]));

  it('creates module chunks for every ancestor directory up to `.`', () => {
    expect(chunks.map((c) => c.id)).toEqual([
      '.',
      'README.ts',
      'src',
      'src/a.ts',
      'src/auth',
      'src/auth/session.ts',
      'src/auth/session.ts#refresh',
      'src/auth/session.ts#revoke',
      'src/auth/session.ts#~top',
    ]);
    expect(byId.get('.')).toMatchObject({ kind: 'module', parentId: null, title: 'repo', isLeaf: false, questionCount: 0, ranges: [] });
    expect(byId.get('src/auth')).toMatchObject({ parentId: 'src', title: 'auth' });
    expect(byId.get('src/a.ts')).toMatchObject({ kind: 'file', parentId: 'src', isLeaf: true, lang: 'typescript', source: 'code' });
    expect(byId.get('README.ts')!.parentId).toBe('.');
  });

  it('assigns parent ids, hashes, metrics and question counts', () => {
    const refresh = byId.get('src/auth/session.ts#refresh')!;
    expect(refresh).toMatchObject({ kind: 'symbol', parentId: 'src/auth/session.ts', isLeaf: true, title: 'refresh' });
    expect(refresh.metrics).toEqual({ loc: 150, complexity: 3, fanIn: 0 });
    expect(refresh.questionCount).toBe(5);
    expect(refresh.contentHash).toBe(contentHash(lines.get(refresh.id)!));
    expect(byId.get('src/auth/session.ts')).toMatchObject({ isLeaf: false, questionCount: 0 });
    expect(byId.get('src/a.ts')!.questionCount).toBe(3);
  });

  it('aggregates module LOC/complexity and hashes child id:hash pairs', () => {
    const src = byId.get('src')!;
    const kids = chunks.filter((c) => c.parentId === 'src');
    expect(src.metrics.loc).toBe(310);
    expect(src.metrics.complexity).toBe(kids.reduce((s, c) => s + c.metrics.complexity, 0));
    expect(src.contentHash).toBe(moduleHash(kids));
    expect(byId.get('.')!.metrics.loc).toBe(313);
  });

  it('is deterministic regardless of input order', () => {
    const again = buildTree([...files].reverse(), cfg, { rootTitle: 'repo' });
    expect(again.chunks).toEqual(chunks);
  });

  it('module hash changes when any descendant changes', () => {
    const changed = buildTree([file('src/auth/session.ts', 300, [fn('refresh', 1, 150), fn('revoke', 151, 290)]), file('src/a.ts', 11), file('README.ts', 3)], cfg);
    const after = new Map(changed.chunks.map((c) => [c.id, c.contentHash]));
    expect(after.get('src')).not.toBe(byId.get('src')!.contentHash);
    expect(after.get('src/auth')).toBe(byId.get('src/auth')!.contentHash);
  });

  it('uses the fanIn index when given', () => {
    const fanIn = buildFanIn(
      [
        { path: 'src/a.ts', lang: 'typescript', imports: [{ specifier: './auth/session', names: [{ imported: 'refresh', local: 'refresh' }], line: 1 }], idents: new Set(['refresh']) },
        { path: 'README.ts', lang: 'typescript', imports: [{ specifier: './src/a', names: [], line: 1 }], idents: new Set() },
      ],
      new Set(files.map((f) => f.path)),
    );
    const t = new Map(buildTree(files, cfg, { fanIn }).chunks.map((c) => [c.id, c.metrics.fanIn]));
    expect(t.get('src/auth/session.ts')).toBe(1);
    expect(t.get('src/auth/session.ts#refresh')).toBe(1);
    expect(t.get('src/auth/session.ts#revoke')).toBe(0);
    expect(t.get('src/auth')).toBe(1);
    expect(t.get('src')).toBe(1);
    expect(t.get('.')).toBe(0);
  });

  it('rejects duplicate chunk ids instead of silently overwriting', () => {
    expect(() => buildTree([file('a.ts', 3), file('a.ts', 3)], cfg)).toThrow('Duplicate chunk id: a.ts');
  });

  it("labels modules with their children's chunker id, or mixed", () => {
    const md: BuiltFile = { ...file('docs/guide.md', 3), source: 'markdown' };
    const { chunks: built } = buildTree([file('src/a.ts', 3), md], cfg);
    const source = (id: string) => built.find((c) => c.id === id)!.source;
    expect([source('src'), source('docs'), source('.')]).toEqual(['code', 'markdown', 'mixed']);
  });

  it('produces just the root module for an empty repo', () => {
    expect(buildTree([], cfg).chunks).toEqual([
      expect.objectContaining({ id: '.', kind: 'module', parentId: null, metrics: { loc: 0, complexity: 0, fanIn: 0 } }),
    ]);
  });
});
