import { beforeAll, describe, expect, it } from 'vitest';
import type { ChunkDraft } from '../../src/chunk/chunker.js';
import { CodeChunker } from '../../src/chunk/code-chunker.js';
import { buildTree } from '../../src/chunk/tree-builder.js';
import { defaultConfig } from '../../src/config/load.js';
import { contentHash } from '../../src/hash/hash.js';
import { createDefaultRegistry } from '../../src/parse/registry.js';

const cfg = defaultConfig();
const chunker = new CodeChunker(createDefaultRegistry());

beforeAll(async () => {
  await createDefaultRegistry().initAll();
});

/** `n` small helper functions of `body` statements each. */
const helpers = (names: string[], body = 3) =>
  names.map((n) => `export function ${n}(x: number): number {\n${Array.from({ length: body }, (_, i) => `  x = x + ${i};`).join('\n')}\n  return x;\n}\n`).join('\n');

const bigClass = (methods: number, perMethod: number) =>
  `export class Big {\n  private n = 0;\n${Array.from(
    { length: methods },
    (_, m) => `  m${m}(a: number): number {\n${Array.from({ length: perMethod }, (_, i) => `    if (a > ${i}) a -= ${i};`).join('\n')}\n    return a;\n  }`,
  ).join('\n')}\n}\n`;

const ids = (d: ChunkDraft, prefix = ''): string[] =>
  d.children.flatMap((c) => [prefix + c.symbolPath.join('.'), ...ids(c, prefix)]);

describe('CodeChunker', () => {
  it('supports registered extensions only', () => {
    expect(chunker.supports('a.ts')).toBe(true);
    expect(chunker.supports('a.py')).toBe(true);
    expect(chunker.supports('a.md')).toBe(false);
  });

  it('keeps a small file as one leaf', async () => {
    const d = await chunker.chunk({ path: 'src/u.ts', text: helpers(['a', 'b']) }, cfg.chunking);
    expect(d).toMatchObject({ kind: 'file', lang: 'typescript', children: [] });
    expect(d.normalizedLines.length).toBe(12);
  });

  it('groups small siblings with ids derived from the first member and splits big classes', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `h${i}`);
    const text = `import { x } from './x';\n\n${helpers(names)}\n${bigClass(30, 9)}`;
    const d = await chunker.chunk({ path: 'src/big.ts', text }, cfg.chunking);
    expect(ids(d)).toEqual([
      '~group:h0',
      '~group:h7',
      'Big',
      // 12-line methods: groups close once they reach leafMinLoc (4 × 12 = 48).
      ...[0, 4, 8, 12, 16, 20, 24, 28].map((i) => `Big.~group:m${i}`),
      'Big.~body',
      '~top',
    ]);
    const group = d.children[0]!;
    expect(group.members).toEqual(names.slice(0, 7).map((n) => [n]));
    expect(group.normalizedLines.length).toBeGreaterThanOrEqual(cfg.chunking.leafMinLoc);
  });

  it('group ids stay stable when a member body changes, and move with the first member', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'];
    const pad = '\n' + bigClass(3, 70);
    const a = await chunker.chunk({ path: 'f.ts', text: helpers(names) + pad }, cfg.chunking);
    const b = await chunker.chunk({ path: 'f.ts', text: helpers(names).replace('x = x + 2;', 'x = x * 2;') + pad }, cfg.chunking);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)[0]).toBe('~group:alpha');
  });

  it('content hash ignores comments, whitespace and CRLF but not token edits', async () => {
    const base = 'export function f(a: number) {\n  return a + 1;\n}\n';
    const variants = [
      '/** Docs. */\nexport function f(a: number) {\n  // why\n  return a + 1; /* trailing */\n}\n',
      'export   function f(a: number) {\r\n\r\n\t\treturn a + 1;\r\n}\r\n',
      '﻿' + base,
    ];
    const hash = async (text: string) => contentHash((await chunker.chunk({ path: 'f.ts', text }, cfg.chunking)).normalizedLines);
    const h = await hash(base);
    for (const v of variants) expect(await hash(v)).toBe(h);
    expect(await hash(base.replace('a + 1', 'a + 2'))).not.toBe(h);
  });

  it('strips Python docstrings and comments from the hash', async () => {
    const a = 'def f(x):\n    return x + 1\n';
    const b = 'def f(x):\n    """Adds one."""\n    # comment\n    return x + 1  # trailing\n';
    const da = await chunker.chunk({ path: 'm.py', text: a }, cfg.chunking);
    const db = await chunker.chunk({ path: 'm.py', text: b }, cfg.chunking);
    expect(contentHash(db.normalizedLines)).toBe(contentHash(da.normalizedLines));
    expect(db.lang).toBe('python');
  });

  it('chunks Python classes into methods when split', async () => {
    const method = (i: number) => `    def m${i}(self, a):\n${Array.from({ length: 20 }, (_, k) => `        a = a + ${k}`).join('\n')}\n        return a\n`;
    const text = `import os\n\nclass Big:\n    x = 1\n\n${Array.from({ length: 16 }, (_, i) => method(i)).join('\n')}`;
    const d = await chunker.chunk({ path: 'p/big.py', text }, cfg.chunking);
    expect(ids(d)).toEqual(['Big', ...Array.from({ length: 16 }, (_, i) => `Big.m${i}`), 'Big.~body', '~top']);
  });

  it('chunks files with syntax errors from the partial tree', async () => {
    const text = `${helpers(['a'])}\nexport function broken( {\n`;
    const d = await chunker.chunk({ path: 'b.ts', text }, cfg.chunking);
    expect(d.parseFailed).toBeUndefined();
    expect(d.normalizedLines.length).toBeGreaterThan(0);
  });

  it('falls back to a single leaf for unsupported paths', async () => {
    const d = await chunker.chunk({ path: 'notes.txt', text: 'a\n'.repeat(500) }, cfg.chunking);
    expect(d).toMatchObject({ parseFailed: true, children: [], complexity: 1 });
    expect(d.lang).toBeUndefined();
  });

  it('extracts references for fanIn', async () => {
    const r = await chunker.references({ path: 'a.ts', text: "import { b as c } from './b';\nc();\n" });
    expect(r.imports).toEqual([{ specifier: './b', names: [{ imported: 'b', local: 'c' }], line: 1 }]);
    expect(r.idents).toContain('c');
    expect(await chunker.references({ path: 'a.txt', text: '' })).toEqual({ imports: [], idents: [] });
  });

  it('feeds buildTree with stable symbol ids', async () => {
    const text = `${helpers(['one'], 80)}\n${helpers(['two'], 80)}\n${helpers(['two'], 80)}`;
    const draft = await chunker.chunk({ path: 'src/dup.ts', text }, cfg.chunking);
    const { chunks } = buildTree([{ path: 'src/dup.ts', source: 'code', draft }], cfg);
    expect(chunks.map((c) => c.id)).toEqual(['.', 'src', 'src/dup.ts', 'src/dup.ts#one', 'src/dup.ts#two', 'src/dup.ts#two@2']);
  });

  it('real names never collide with synthetic segments (@N, ~top) and are NFC', async () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `  export const v${i} = ${i};`).join('\n');
    const text = [
      `namespace a {\n${body(30)}\n}`,
      `namespace a {\n${body(30)}\n}`,
      `declare module 'a@2' {\n${body(30)}\n}`,
      `declare module '~top' {\n${body(30)}\n}`,
      `export function café() {\n${body(30).replace(/export /g, '')}\n}`,
      ...Array.from({ length: 120 }, (_, i) => `console.log(${i});`),
    ].join('\n');
    const draft = await chunker.chunk({ path: 'd.ts', text }, cfg.chunking);
    const { chunks } = buildTree([{ path: 'd.ts', source: 'code', draft }], cfg);
    const idList = chunks.map((c) => c.id);
    expect(new Set(idList).size).toBe(idList.length);
    expect(idList).toEqual(expect.arrayContaining(['d.ts#a', 'd.ts#a@2', 'd.ts#a_2', 'd.ts#_top', 'd.ts#~top', 'd.ts#café']));
    for (const id of idList) expect(id).toBe(id.normalize('NFC'));
  });

  it('falls back to a single leaf instead of throwing on pathological nesting', async () => {
    const branches = Array.from({ length: 6000 }, (_, i) => `  else if (x === ${i + 1}) return ${i};`).join('\n');
    const text = `export function deep(x: number): number {\n  if (x === 0) return 0;\n${branches}\n  return -1;\n}\n`;
    const d = await chunker.chunk({ path: 'deep.ts', text }, cfg.chunking);
    expect(d.normalizedLines.length).toBeGreaterThan(6000);
    expect(d.children).toEqual([]);
  });

  it('uses POSIX paths in ids and ranges even for win32-style input', async () => {
    const draft = await chunker.chunk({ path: 'src\\win\\x.ts', text: 'export const a = 1;\n' }, cfg.chunking);
    expect(draft.ranges).toEqual([{ path: 'src/win/x.ts', start: 1, end: 1 }]);
    const { chunks } = buildTree([{ path: 'src\\win\\x.ts', source: 'code', draft }], cfg);
    expect(chunks.map((c) => c.id)).toEqual(['.', 'src', 'src/win', 'src/win/x.ts']);
  });
});
