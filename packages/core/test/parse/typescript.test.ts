import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createJavaScriptParser, createTsxParser, createTypeScriptParser } from '../../src/parse/lang/typescript.js';
import type { LanguageParser, ParsedFile, SymbolNode } from '../../src/parse/parser.js';

const ts = createTypeScriptParser();
const tsx = createTsxParser();
const js = createJavaScriptParser();

beforeAll(async () => {
  await Promise.all([ts.init(), tsx.init(), js.init()]);
});

const open: ParsedFile[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.dispose();
});

function parse(p: LanguageParser, lines: string[]): ParsedFile {
  const f = p.parse(lines.join('\n') + '\n');
  open.push(f);
  return f;
}

/** Compact `name:kind:start-end` view of a symbol tree. */
function shape(s: SymbolNode[]): unknown[] {
  return s.map((n) => (n.children.length ? [`${n.name}:${n.kind}:${n.start}-${n.end}`, shape(n.children)] : `${n.name}:${n.kind}:${n.start}-${n.end}`));
}

describe('TypeScript symbols', () => {
  it('unwraps exports, includes decorators and collects class members', () => {
    const f = parse(ts, [
      'import { x } from "./x";', // 1
      '', // 2
      '/** Store docs */', // 3
      '@Injectable()', // 4
      'export class Store<T> {', // 5
      '  #items = new Map<string, T>();', // 6
      '  constructor(private readonly name: string) {}', // 7
      '  @Memo()', // 8
      '  get size(): number {', // 9
      '    return this.#items.size;', // 10
      '  }', // 11
      '  set label(v: string) {}', // 12
      '  #evict(): void {}', // 13
      '  ["computed"]() {}', // 14
      '  onChange = (v: T) => {', // 15
      '    void v;', // 16
      '  };', // 17
      '  static create = function () { return 1; };', // 18
      '  limit = 10;', // 19
      '}', // 20
      'export abstract class Base {', // 21
      '  abstract run(): void;', // 22
      '  stop() {}', // 23
      '}', // 24
      'export interface Opts { a: number }', // 25
      'export type Id = string;', // 26
      'enum Color { Red }', // 27
      'namespace NS {', // 28
      '  export function inner() {}', // 29
      '}', // 30
      'declare module "ambient" {}', // 31
    ]);
    expect(f.hasError).toBe(false);
    expect(shape(ts.symbols(f))).toEqual([
      [
        'Store:class:4-20',
        [
          'constructor:method:7-7',
          'size:method:8-11',
          'label:method:12-12',
          '#evict:method:13-13',
          '["computed"]:method:14-14',
          'onChange:method:15-17',
          'create:method:18-18',
        ],
      ],
      ['Base:class:21-24', ['stop:method:23-23']],
      'Opts:other:25-25',
      'Id:other:26-26',
      'Color:other:27-27',
      ['NS:other:28-30', ['inner:function:29-29']],
      'ambient:other:31-31',
    ]);
  });

  it('handles top-level variables, default exports and duplicates', () => {
    const f = parse(ts, [
      'export const add = (a: number, b: number): number => a + b;', // 1
      'const LIMIT = 5;', // 2
      'let { a, b } = obj;', // 3
      'var x = 1, y = function named() {};', // 4
      'export const handler = async (', // 5
      '  e: Event,', // 6
      ') => {', // 7
      '  return e;', // 8
      '};', // 9
      'function dup() {}', // 10
      'function dup() {}', // 11
      'function* gen() {}', // 12
      'export default function () {}', // 13
    ]);
    expect(shape(ts.symbols(f))).toEqual([
      'add:function:1-1',
      'LIMIT:variable:2-2',
      'x:variable:4-4',
      'y:function:4-4',
      'handler:function:5-9',
      'dup:function:10-10',
      'dup:function:11-11',
      'gen:function:12-12',
      'default:function:13-13',
    ]);
  });

  it('anonymous default class and decorated export statements', () => {
    const f = parse(ts, ['@Component({})', 'export default class {', '  render() {}', '}']);
    expect(shape(ts.symbols(f))).toEqual([['default:class:1-4', ['render:method:3-3']]]);
  });

  it('collects nested functions at statement level only', () => {
    const f = parse(ts, [
      'export function outer(flag: boolean) {', // 1
      '  const n = 5;', // 2
      '  function helper() {', // 3
      '    function deep() {}', // 4
      '  }', // 5
      '  if (flag) {', // 6
      '    const cb = () => n;', // 7
      '  } else {', // 8
      '    try {', // 9
      '      class Local { m() {} }', // 10
      '    } catch {}', // 11
      '  }', // 12
      '  items.forEach(function each() {});', // 13
      '  return () => 1;', // 14
      '}', // 15
      'const wrap = () => {', // 16
      '  const inner = function () {};', // 17
      '};', // 18
    ]);
    expect(shape(ts.symbols(f))).toEqual([
      [
        'outer:function:1-15',
        [['helper:function:3-5', ['deep:function:4-4']], 'cb:function:7-7', ['Local:class:10-10', ['m:method:10-10']]],
      ],
      ['wrap:function:16-18', ['inner:function:17-17']],
    ]);
  });

  it('TSX component', () => {
    const f = parse(tsx, [
      'import React from "react";',
      'export function App({ items }: Props) {',
      '  const Row = ({ v }: { v: string }) => <li>{v}</li>;',
      '  return <ul>{items.map((v) => <Row v={v} />)}</ul>;',
      '}',
    ]);
    expect(f.hasError).toBe(false);
    expect(shape(tsx.symbols(f))).toEqual([['App:function:2-5', ['Row:function:3-3']]]);
    expect(tsx.identifiers(f).has('Row')).toBe(true);
    expect(tsx.identifiers(f).has('React')).toBe(false);
  });

  it('JavaScript with JSX, class fields and decorators', () => {
    const f = parse(js, [
      '@observer', // 1
      'class View {', // 2
      '  static make = function () {};', // 3
      '  #count = 0;', // 4
      '  click = () => this.#count++;', // 5
      '  render() { return <div onClick={this.click} />; }', // 6
      '}', // 7
      'module.exports = { View };', // 8
    ]);
    expect(f.hasError).toBe(false);
    expect(shape(js.symbols(f))).toEqual([['View:class:1-7', ['make:method:3-3', 'click:method:5-5', 'render:method:6-6']]]);
  });
});

describe('TypeScript comments', () => {
  it('returns line, block and JSDoc comments sorted by offset', () => {
    const src = '/** Doc */\nconst a = 1; // trailing\n/* block\n   two */\nfunction f() { /* in */ }\n';
    const f = ts.parse(src);
    open.push(f);
    const texts = ts.commentRanges(f).map((r) => src.slice(r.start, r.end));
    expect(texts).toEqual(['/** Doc */', '// trailing', '/* block\n   two */', '/* in */']);
  });

  it('slices exact comment text with Turkish identifiers and emoji strings', () => {
    const src = 'const şğüİ = "🎉🎉 çok güzel";\n// yorum: ığüşöç 🚀\nfunction ölç() { /* 😀 iç */ return şğüİ; }\n';
    const f = ts.parse(src);
    open.push(f);
    const texts = ts.commentRanges(f).map((r) => src.slice(r.start, r.end));
    expect(texts).toEqual(['// yorum: ığüşöç 🚀', '/* 😀 iç */']);
    expect(shape(ts.symbols(f))).toEqual(['şğüİ:variable:1-1', 'ölç:function:3-3']);
  });

  it('includes html_comment in JavaScript', () => {
    const src = '<!-- legacy\nconst a = 1;\n';
    const f = js.parse(src);
    open.push(f);
    expect(js.commentRanges(f).map((r) => src.slice(r.start, r.end))).toEqual(['<!-- legacy']);
  });
});

describe('TypeScript complexity', () => {
  it('counts each decision node type once', () => {
    const cases: [string, number][] = [
      ['if (a) {}', 2],
      ['if (a) {} else if (b) {} else {}', 3],
      ['for (let i = 0; i < n; i++) {}', 2],
      ['for (const k in o) {}', 2],
      ['for (const v of xs) {}', 2],
      ['while (a) {}', 2],
      ['do {} while (a);', 2],
      ['switch (a) { case 1: break; case 2: break; default: }', 3],
      ['try {} catch (e) {} finally {}', 2],
      ['const v = a ? 1 : 2;', 2],
      ['const v = a && b;', 2],
      ['const v = a || b;', 2],
      ['const v = a ?? b;', 2],
      ['const v = a + b * c;', 1],
      ['const v = a === b;', 1],
    ];
    for (const [code, expected] of cases) {
      const f = ts.parse(code + '\n');
      open.push(f);
      expect(ts.complexity(f, 1, 1), code).toBe(expected);
    }
    const f = js.parse('const v = (a && b) || (c ?? d);\n');
    open.push(f);
    expect(js.complexity(f, 1, 1)).toBe(4);
  });

  it('only counts decisions starting inside the line window', () => {
    const f = parse(ts, [
      'function a(x) {', // 1
      '  if (x) return 1;', // 2
      '  return x ? 2 : 3;', // 3
      '}', // 4
      'function b(y) {', // 5
      '  while (y) {', // 6
      '    if (y > 1 && y < 5) y--;', // 7
      '  }', // 8
      '}', // 9
    ]);
    expect(ts.complexity(f, 1, 4)).toBe(3);
    expect(ts.complexity(f, 5, 9)).toBe(4);
    expect(ts.complexity(f, 7, 7)).toBe(3);
    expect(ts.complexity(f, 1, 9)).toBe(6);
    expect(ts.complexity(f, 4, 5)).toBe(1);
  });
});

describe('TypeScript imports', () => {
  it('extracts every import form in source order', () => {
    const f = parse(ts, [
      "import d, { a, b as c } from './x';", // 1
      "import * as ns from './ns';", // 2
      "import './side';", // 3
      "import type { T } from './types';", // 4
      "export { a, b as c2 } from './re';", // 5
      "export * from './all';", // 6
      "export * as nsx from './nsx';", // 7
      "import q = require('./q');", // 8
      "const r = require('./r');", // 9
      "require('./bare');", // 10
      "const { m, n: o } = require('./m');", // 11
      "const lazy = import('./lazy');", // 12
      "const dyn = require(name);", // 13
      'export { local };', // 14
      'function f() {', // 15
      "  const inner = require('./inner');", // 16
      '}', // 17
    ]);
    expect(ts.imports(f)).toEqual([
      {
        specifier: './x',
        names: [
          { imported: 'default', local: 'd' },
          { imported: 'a', local: 'a' },
          { imported: 'b', local: 'c' },
        ],
        line: 1,
      },
      { specifier: './ns', names: [], namespace: { local: 'ns' }, line: 2 },
      { specifier: './side', names: [], line: 3 },
      { specifier: './types', names: [{ imported: 'T', local: 'T' }], line: 4 },
      {
        specifier: './re',
        names: [
          { imported: 'a', local: 'a' },
          { imported: 'b', local: 'c2' },
        ],
        line: 5,
      },
      { specifier: './all', names: [], namespace: { local: null }, line: 6 },
      { specifier: './nsx', names: [], namespace: { local: 'nsx' }, line: 7 },
      { specifier: './q', names: [], namespace: { local: 'q' }, line: 8 },
      { specifier: './r', names: [], namespace: { local: 'r' }, line: 9 },
      { specifier: './bare', names: [], namespace: { local: null }, line: 10 },
      {
        specifier: './m',
        names: [
          { imported: 'm', local: 'm' },
          { imported: 'n', local: 'o' },
        ],
        line: 11,
      },
      { specifier: './inner', names: [], namespace: { local: 'inner' }, line: 16 },
    ]);
  });

  it('handles JavaScript CommonJS and ESM', () => {
    const f = parse(js, ["import React, * as all from 'react';", "const path = require('node:path');"]);
    expect(js.imports(f)).toEqual([
      { specifier: 'react', names: [{ imported: 'default', local: 'React' }], namespace: { local: 'all' }, line: 1 },
      { specifier: 'node:path', names: [], namespace: { local: 'path' }, line: 2 },
    ]);
  });
});

describe('TypeScript identifiers', () => {
  it('collects references but not import bindings', () => {
    const f = parse(ts, [
      "import { helper, Unused } from './h';",
      "import Def from './d';",
      "import * as NS from './ns';",
      "import Q = require('./q');",
      "export { reexported } from './r';",
      'export function run(opt: Options): Result {',
      '  const { shorthand } = opt;',
      '  return helper({ shorthand, key: NS.member });',
      '}',
    ]);
    const ids = ts.identifiers(f);
    for (const n of ['helper', 'run', 'opt', 'Options', 'Result', 'shorthand', 'key', 'NS', 'member']) expect(ids.has(n), n).toBe(true);
    for (const n of ['Unused', 'Def', 'Q', 'reexported']) expect(ids.has(n), n).toBe(false);
  });
});

describe('TypeScript error tolerance', () => {
  it('produces partial results for files with syntax errors', () => {
    const f = parse(ts, [
      "import { a } from './a';",
      'export function good() { return a; }',
      'function broken( {',
      '  if (x) {',
      'class Later { m() {} }',
    ]);
    expect(f.hasError).toBe(true);
    expect(() => ts.symbols(f)).not.toThrow();
    expect(ts.symbols(f).map((s) => s.name)).toContain('good');
    expect(ts.imports(f)).toHaveLength(1);
    expect(() => ts.commentRanges(f)).not.toThrow();
    expect(() => ts.complexity(f, 1, 5)).not.toThrow();
    expect(() => ts.identifiers(f)).not.toThrow();
  });

  it('rejects a disposed file', () => {
    const f = ts.parse('const a = 1;');
    f.dispose();
    expect(() => ts.symbols(f)).toThrow(/disposed/);
    f.dispose(); // idempotent
  });
});
