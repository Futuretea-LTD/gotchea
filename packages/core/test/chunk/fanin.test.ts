import { describe, expect, it } from 'vitest';
import { buildFanIn, resolveImport, type FileReferences } from '../../src/chunk/fanin.js';
import type { ImportRef } from '../../src/parse/parser.js';

const known = new Set([
  'src/a.ts',
  'src/b.tsx',
  'src/util/index.ts',
  'src/lib.mts',
  'src/plain.js',
  'pkg/__init__.py',
  'pkg/mod.py',
  'pkg/sub/__init__.py',
  'pkg/sub/deep.py',
  'src/app/core.py',
  'main.py',
]);

const ref = (specifier: string, names: [string, string][] = [], namespace?: string | null): ImportRef => ({
  specifier,
  names: names.map(([imported, local]) => ({ imported, local })),
  ...(namespace === undefined ? {} : { namespace: { local: namespace } }),
  line: 1,
});

describe('resolveImport', () => {
  it.each([
    ['src/x.ts', './a', 'src/a.ts'],
    ['src/x.ts', './a.js', 'src/a.ts'],
    ['src/x.ts', './b.jsx', 'src/b.tsx'],
    ['src/x.ts', './b', 'src/b.tsx'],
    ['src/x.ts', './util', 'src/util/index.ts'],
    ['src/util/x.ts', '..', null],
    ['src/util/x.ts', '../lib.mjs', 'src/lib.mts'],
    ['src/x.ts', './plain.js', 'src/plain.js'],
    ['src/x.ts', 'react', null],
    ['src/x.ts', '../../outside', null],
    ['src/x.ts', './missing', null],
  ])('ts: %s imports %s → %s', (from, spec, expected) => {
    expect(resolveImport(from, 'typescript', spec, known)).toBe(expected);
  });

  it.each([
    ['pkg/x.py', '.mod', 'pkg/mod.py'],
    ['pkg/x.py', '.', 'pkg/__init__.py'],
    ['pkg/sub/x.py', '..mod', 'pkg/mod.py'],
    ['pkg/sub/x.py', '.deep', 'pkg/sub/deep.py'],
    ['pkg/sub/x.py', '...', null],
    ['main.py', 'pkg.sub.deep', 'pkg/sub/deep.py'],
    ['main.py', 'pkg.sub', 'pkg/sub/__init__.py'],
    ['main.py', 'app.core', 'src/app/core.py'],
    ['main.py', 'os', null],
    ['main.py', '..x', null],
  ])('python: %s imports %s → %s', (from, spec, expected) => {
    expect(resolveImport(from, 'python', spec, known)).toBe(expected);
  });
});

describe('buildFanIn', () => {
  const file = (path: string, lang: string, imports: ImportRef[], idents: string[]): FileReferences => ({
    path,
    lang,
    imports,
    idents: new Set(idents),
  });

  const files: FileReferences[] = [
    file('src/x.ts', 'typescript', [ref('./a', [['parse', 'p'], ['Store', 'Store']])], ['p', 'Store', 'get']),
    file('src/y.ts', 'typescript', [ref('./a', [['parse', 'parse']])], []), // imported but never used
    file('src/z.ts', 'typescript', [ref('./a', [], 'ns'), ref('./a', [['parse', 'parse']])], ['ns', 'Store']),
    file('src/re.ts', 'typescript', [ref('./a', [], null)], []),
    file('src/a.ts', 'typescript', [ref('./a', [['self', 'self']])], ['self']),
    file('main.py', 'python', [ref('pkg', [['mod', 'mod'], ['helper', 'helper']]), ref('pkg.sub.deep', [], 'pkg')], ['mod', 'run', 'helper', 'pkg', 'walk']),
    file('pkg/sub/x.py', 'python', [ref('..mod', [['run', 'go']])], ['go']),
  ];
  const idx = buildFanIn(files, known);

  it('file fanIn counts distinct importing files, never the file itself', () => {
    expect(idx.file('src/a.ts')).toBe(4);
    expect([...idx.importers('src/a.ts')].sort()).toEqual(['src/re.ts', 'src/x.ts', 'src/y.ts', 'src/z.ts']);
    expect(idx.file('src/b.tsx')).toBe(0);
  });

  it('symbol fanIn requires import by name plus a reference to the local binding', () => {
    // x: aliased + used; y: imported, unused; z: via namespace (ns.parse not referenced as ident 'parse');
    // re: `export *` re-export counts every export.
    expect(idx.symbol('src/a.ts', [['parse']])).toBe(2);
    expect(idx.symbol('src/a.ts', [['Store']])).toBe(3);
  });

  it('nested symbols also need the member name; groups take the union; synthetic segments count nothing', () => {
    expect(idx.symbol('src/a.ts', [['Store', 'get']])).toBe(1);
    expect(idx.symbol('src/a.ts', [['Store', 'put']])).toBe(0);
    expect(idx.symbol('src/a.ts', [['parse'], ['Store']])).toBe(3);
    expect(idx.symbol('src/a.ts', [['~top']])).toBe(0);
    expect(idx.symbol('src/missing.ts', [['x']])).toBe(0);
  });

  it('python: submodule imports, package names and namespace imports', () => {
    expect(idx.file('pkg/mod.py')).toBe(2);
    expect(idx.symbol('pkg/mod.py', [['run']])).toBe(2);
    expect(idx.symbol('pkg/__init__.py', [['helper']])).toBe(1);
    expect(idx.symbol('pkg/sub/deep.py', [['walk']])).toBe(1);
  });

  it('module fanIn counts importers outside the directory', () => {
    expect(idx.module('pkg')).toBe(1);
    expect(idx.module('pkg/sub')).toBe(1);
    expect(idx.module('src')).toBe(0);
    expect(idx.module('.')).toBe(0);
  });
});
