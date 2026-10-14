import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPythonParser } from '../../src/parse/lang/python.js';
import type { ParsedFile, SymbolNode } from '../../src/parse/parser.js';

const py = createPythonParser();

beforeAll(async () => {
  await py.init();
});

const open: ParsedFile[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.dispose();
});

function parse(lines: string[]): ParsedFile {
  const f = py.parse(lines.join('\n') + '\n');
  open.push(f);
  return f;
}

function shape(s: SymbolNode[]): unknown[] {
  return s.map((n) => (n.children.length ? [`${n.name}:${n.kind}:${n.start}-${n.end}`, shape(n.children)] : `${n.name}:${n.kind}:${n.start}-${n.end}`));
}

describe('Python symbols', () => {
  it('extracts classes, decorated methods, nested functions and assignments', () => {
    const f = parse([
      'import os', // 1
      'MAX: int = 10', // 2
      'a, b = 1, 2', // 3
      'NAME = "x"', // 4
      '', // 5
      '@dataclass', // 6
      '@other(1)', // 7
      'class Point:', // 8
      '    """A point."""', // 9
      '    x: int = 0', // 10
      '    @property', // 11
      '    def norm(self):', // 12
      '        def sq(v):', // 13
      '            return v * v', // 14
      '        return sq(self.x)', // 15
      '    async def load(self):', // 16
      '        pass', // 17
      '    class Meta:', // 18
      '        pass', // 19
      '', // 20
      'def outer(flag):', // 21
      '    if flag:', // 22
      '        def a(): pass', // 23
      '    else:', // 24
      '        try:', // 25
      '            class Inner:', // 26
      '                def m(self): pass', // 27
      '        except Exception:', // 28
      '            pass', // 29
      '    for i in range(3):', // 30
      '        @wraps(i)', // 31
      '        def b(): pass', // 32
      '    with open("f") as fh:', // 33
      '        def c(): pass', // 34
      '    return [lambda: 1]', // 35
      '', // 36
      'def dup(): pass', // 37
      'def dup(): pass', // 38
    ]);
    expect(f.hasError).toBe(false);
    expect(shape(py.symbols(f))).toEqual([
      'MAX:variable:2-2',
      'NAME:variable:4-4',
      [
        'Point:class:6-19',
        [['norm:method:11-15', ['sq:function:13-14']], 'load:method:16-17', 'Meta:class:18-19'],
      ],
      [
        'outer:function:21-35',
        ['a:function:23-23', ['Inner:class:26-27', ['m:method:27-27']], 'b:function:31-32', 'c:function:34-34'],
      ],
      'dup:function:37-37',
      'dup:function:38-38',
    ]);
  });
});

describe('Python comments and docstrings', () => {
  it('returns comments plus module/class/function docstrings', () => {
    const src = [
      '"""Module doc."""', // docstring
      '# comment one',
      'x = 1',
      '"""not a docstring"""',
      'class A:',
      '    # leading comment',
      '    "class doc" " continued"',
      '    def f(self):',
      "        '''fn doc'''",
      '        y = 2',
      '        "not doc either"',
      '        return y  # trailing',
      'def g():',
      '    return "x"',
      '',
    ].join('\n');
    const f = py.parse(src);
    open.push(f);
    const texts = py.commentRanges(f).map((r) => src.slice(r.start, r.end));
    expect(texts).toEqual([
      '"""Module doc."""',
      '# comment one',
      '# leading comment',
      '"class doc" " continued"',
      "'''fn doc'''",
      '# trailing',
    ]);
  });

  it('does not treat f-strings or bytes in docstring position as docstrings', () => {
    const src = ['def f(x):', '    f"""{x + 1}"""', '    return x', 'def g():', '    b"raw"', '    return 1', 'def h():', '    r"""raw doc"""', ''].join('\n');
    const f = py.parse(src);
    open.push(f);
    expect(py.commentRanges(f).map((r) => src.slice(r.start, r.end))).toEqual(['r"""raw doc"""']);
  });

  it('slices exact text with Turkish identifiers and emoji strings', () => {
    const src = 'şehir = "İstanbul 🌉"\n# açıklama: ğüşöç 🚀\ndef ölç():\n    """Ölçer 😀."""\n    return şehir\n';
    const f = py.parse(src);
    open.push(f);
    expect(py.commentRanges(f).map((r) => src.slice(r.start, r.end))).toEqual(['# açıklama: ğüşöç 🚀', '"""Ölçer 😀."""']);
    expect(shape(py.symbols(f))).toEqual(['şehir:variable:1-1', 'ölç:function:3-5']);
  });
});

describe('Python complexity', () => {
  it('counts each decision node type', () => {
    const cases: [string[], number][] = [
      [['if a:', '    pass'], 2],
      [['if a:', '    pass', 'elif b:', '    pass', 'else:', '    pass'], 3],
      [['for i in x:', '    pass'], 2],
      [['while a:', '    pass'], 2],
      [['try:', '    pass', 'except A:', '    pass', 'except B:', '    pass', 'finally:', '    pass'], 3],
      [['v = 1 if a else 2'], 2],
      [['v = a and b'], 2],
      [['v = a or b or c'], 3],
      [['v = [i for i in x if i]'], 2],
      [['match v:', '    case 1:', '        pass', '    case _:', '        pass'], 3],
      [['v = a + b'], 1],
    ];
    for (const [lines, expected] of cases) {
      const f = parse(lines);
      expect(py.complexity(f, 1, lines.length), lines.join(' / ')).toBe(expected);
    }
  });

  it('only counts decisions starting inside the line window', () => {
    const f = parse([
      'def a(x):', // 1
      '    if x:', // 2
      '        return 1', // 3
      '    return 2', // 4
      'def b(y):', // 5
      '    while y and y > 1:', // 6
      '        y -= 1', // 7
    ]);
    expect(py.complexity(f, 1, 4)).toBe(2);
    expect(py.complexity(f, 5, 7)).toBe(3);
    expect(py.complexity(f, 3, 5)).toBe(1);
  });
});

describe('Python imports', () => {
  it('extracts every import form, including nested ones', () => {
    const f = parse([
      'import a.b.c', // 1
      'import a.b as m', // 2
      'from .mod import x, y as z', // 3
      'from . import x', // 4
      'from ..pkg.sub import *', // 5
      'from pkg import (q,', // 6
      '    r)', // 7
      'import os, sys as system', // 8
      'try:', // 9
      '    import ujson as json', // 10
      'except ImportError:', // 11
      '    def f():', // 12
      '        from pkg.inner import thing', // 13
    ]);
    expect(py.imports(f)).toEqual([
      { specifier: 'a.b.c', names: [], namespace: { local: 'a' }, line: 1 },
      { specifier: 'a.b', names: [], namespace: { local: 'm' }, line: 2 },
      {
        specifier: '.mod',
        names: [
          { imported: 'x', local: 'x' },
          { imported: 'y', local: 'z' },
        ],
        line: 3,
      },
      { specifier: '.', names: [{ imported: 'x', local: 'x' }], line: 4 },
      { specifier: '..pkg.sub', names: [], namespace: { local: null }, line: 5 },
      {
        specifier: 'pkg',
        names: [
          { imported: 'q', local: 'q' },
          { imported: 'r', local: 'r' },
        ],
        line: 6,
      },
      { specifier: 'os', names: [], namespace: { local: 'os' }, line: 8 },
      { specifier: 'sys', names: [], namespace: { local: 'system' }, line: 8 },
      { specifier: 'ujson', names: [], namespace: { local: 'json' }, line: 10 },
      { specifier: 'pkg.inner', names: [{ imported: 'thing', local: 'thing' }], line: 13 },
    ]);
  });
});

describe('Python identifiers', () => {
  it('collects references but not import bindings', () => {
    const f = parse(['from .h import helper, Unused', 'import numpy as np', 'def run(opt):', '    return helper(np.array(opt.value))']);
    const ids = py.identifiers(f);
    for (const n of ['helper', 'np', 'array', 'run', 'opt', 'value']) expect(ids.has(n), n).toBe(true);
    for (const n of ['Unused', 'numpy']) expect(ids.has(n), n).toBe(false);
  });
});

describe('Python error tolerance', () => {
  it('produces partial results for files with syntax errors', () => {
    const f = parse(['import os', 'def good():', '    return 1', 'def broken(:', '    x = (', 'class Later:', '    def m(self): pass']);
    expect(f.hasError).toBe(true);
    expect(() => py.symbols(f)).not.toThrow();
    expect(py.symbols(f).map((s) => s.name)).toContain('good');
    expect(py.imports(f)).toHaveLength(1);
    expect(() => py.commentRanges(f)).not.toThrow();
    expect(() => py.complexity(f, 1, 7)).not.toThrow();
    expect(() => py.identifiers(f)).not.toThrow();
  });

  it('throws when used before init()', () => {
    expect(() => createPythonParser().parse('x = 1')).toThrow(/before init/);
  });
});
