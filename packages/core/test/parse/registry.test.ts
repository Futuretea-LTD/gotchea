import { describe, expect, it } from 'vitest';
import { createJavaScriptParser, createTypeScriptParser } from '../../src/parse/lang/typescript.js';
import { createPythonParser } from '../../src/parse/lang/python.js';
import { createDefaultRegistry, ParserRegistry } from '../../src/parse/registry.js';

describe('ParserRegistry', () => {
  it('looks parsers up by lowercase extension', () => {
    const r = createDefaultRegistry();
    expect(r.forPath('src/a.ts')?.lang).toBe('typescript');
    expect(r.forPath('src/a.MTS')?.lang).toBe('typescript');
    expect(r.forPath('src/a.cts')?.lang).toBe('typescript');
    expect(r.forPath('src/App.tsx')?.extensions).toEqual(['.tsx']);
    expect(r.forPath('src/App.tsx')?.lang).toBe('typescript');
    for (const ext of ['js', 'jsx', 'mjs', 'cjs']) expect(r.forPath(`lib/x.${ext}`)?.lang).toBe('javascript');
    expect(r.forPath('pkg/mod.py')?.lang).toBe('python');
    expect(r.forPath('C:\\repo\\mod.PY')?.lang).toBe('python');
    expect(r.forPath('README.md')).toBeUndefined();
    expect(r.forPath('Makefile')).toBeUndefined();
    expect(r.forPath('.ts')).toBeUndefined(); // dotfile, no extension
    expect(r.forPath('dir.ts/file')).toBeUndefined();
    expect(r.supports('a.py')).toBe(true);
    expect(r.supports('a.rb')).toBe(false);
    expect(r.parsers()).toHaveLength(4);
  });

  it('filters by language id (TSX counts as typescript)', () => {
    const ts = createDefaultRegistry(['typescript']);
    expect(ts.parsers().map((p) => p.extensions[0])).toEqual(['.ts', '.tsx']);
    expect(ts.supports('a.tsx')).toBe(true);
    expect(ts.supports('a.js')).toBe(false);
    expect(ts.supports('a.py')).toBe(false);

    const py = createDefaultRegistry(['python', 'javascript']);
    expect(py.parsers().map((p) => p.lang)).toEqual(['javascript', 'python']);
    expect(createDefaultRegistry([]).parsers()).toHaveLength(0);
  });

  it('registers custom parsers and inits them all', async () => {
    const r = new ParserRegistry();
    const js = createJavaScriptParser();
    r.register(js);
    r.register(js);
    r.register(createPythonParser());
    expect(r.parsers()).toHaveLength(2);
    await r.initAll();
    const f = js.parse('const a = 1;\n');
    expect(f.hasError).toBe(false);
    f.dispose();
  });

  it('throws when parse() is called before init()', () => {
    expect(() => createTypeScriptParser().parse('const a = 1;')).toThrow(/before init/);
  });
});
