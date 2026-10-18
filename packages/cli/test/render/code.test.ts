// `codeBlockLines` on its own: layout (header, gutter, truncation), colours on and off, and the
// lexer's token boundaries. Token assertions look for the exact picocolors wrapping of a span.
import type { PublicCodePreview } from 'gotchea-core';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { codeBlockLines } from '../../src/render/code.js';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (t: string): string => t.replace(ANSI_RE, '');
const on = pc.createColors(true);
const off = pc.createColors(false);

function preview(text: string, language = 'typescript', startLine = 1): PublicCodePreview {
  return { path: 'src/a.ts', startLine, endLine: startLine + text.split('\n').length - 1, language, text };
}

/** Code lines only (no header), with the `N │ ` gutter removed. */
function body(text: string, language = 'typescript'): string[] {
  return codeBlockLines(on, preview(text, language))
    .slice(1)
    .map((l) => strip(l).replace(/^\s*\d+ │ ?/, ''));
}

/** The raw (coloured) code part of each line, after the gutter. */
function painted(text: string, language = 'typescript'): string[] {
  const gutter = new RegExp(`^${ESC}\\[2m\\s*\\d+ │${ESC}\\[22m ?`);
  return codeBlockLines(on, preview(text, language))
    .slice(1)
    .map((l) => l.replace(gutter, ''));
}

describe('codeBlockLines layout', () => {
  it('prints a `path:start-end (language)` header', () => {
    expect(codeBlockLines(off, preview('x', 'typescript', 7))[0]).toBe('src/a.ts:7-7 (typescript)');
  });

  it('right-aligns the gutter to the widest line number', () => {
    const lines = codeBlockLines(off, preview('a\nb\nc\nd\ne', 'typescript', 98));
    expect(lines.slice(1)).toEqual([' 98 │ a', ' 99 │ b', '100 │ c', '101 │ d', '102 │ e']);
  });

  it('renders an empty line as the gutter only', () => {
    expect(codeBlockLines(off, preview('a\n\nb')).slice(1)).toEqual(['1 │ a', '2 │', '3 │ b']);
  });

  it('adds a truncation line', () => {
    const lines = codeBlockLines(off, { ...preview('a', 'typescript', 98), endLine: 102, truncated: true });
    expect(lines.at(-1)).toBe('    │ … (truncated)');
  });

  it('emits no escape codes with colours off', () => {
    const text = '// c\nconst s = "x"; /* b */ let n = 42;';
    expect(codeBlockLines(off, preview(text)).join('\n')).not.toContain(ESC);
  });

  it('leaves an unknown language as plain text even with colours on', () => {
    expect(painted('const x = "y"; // z', 'cobol')).toEqual(['const x = "y"; // z']);
    expect(painted('constructor', 'constructor')).toEqual(['constructor']);
  });

  it('round-trips the text exactly once ANSI is stripped', () => {
    const text = [
      'import { a } from "b"; // c',
      '/* open',
      '   middle */ const x = `t` + 1;',
      "const s = 'it\\'s', n = 0x1f + 3.5;",
      '\tif (x) { return "\\\\"; }',
      'const bad = "unterminated',
    ].join('\n');
    expect(body(text)).toEqual(text.split('\n').map((l) => l.replace('\t', '    ')));
  });

  it.each(['typescript', 'python', 'rust', 'go', 'java'])('ends and round-trips on unterminated tokens and trailing backslashes (%s)', (language) => {
    const text = ['"abc\\', "'x\\", '/* never closed', '\\', '"""open \\', "'''", "'", "'a", '`raw\\', '# 🎉 𝕏 \\'].join('\n');
    expect(body(text, language)).toEqual(text.split('\n'));
  });

  it('sanitizes control characters in the header and code', () => {
    const lines = codeBlockLines(on, { ...preview(`clear${ESC}[2J\nok`), path: `a${ESC}]8;;x\u0007.ts`, language: `ts${ESC}[31m` });
    for (const l of lines) expect(l.replace(ANSI_RE, '')).not.toContain(ESC);
    expect(strip(lines[1]!)).toContain('clear␛[2J');
  });

  it.each([false, true])('neutralizes every control and bidi character in all preview strings (colours %s)', (color) => {
    const codes = [
      ...Array.from({ length: 32 }, (_, i) => i).filter((i) => i !== 9 && i !== 10),
      ...Array.from({ length: 33 }, (_, i) => 0x7f + i),
      0x061c, 0x200e, 0x200f,
      ...Array.from({ length: 5 }, (_, i) => 0x202a + i),
      ...Array.from({ length: 4 }, (_, i) => 0x2066 + i),
    ];
    const unsafe = String.fromCodePoint(...codes);
    const output = strip(codeBlockLines(pc.createColors(color), {
      ...preview(`const text = "${unsafe}";\n\treturn text;`),
      path: `src/${unsafe}.ts`,
      language: `typescript${unsafe}`,
    }).join('\n'));
    for (const code of codes) expect(output, `U+${code.toString(16)}`).not.toContain(String.fromCodePoint(code));
    expect(output).toContain('\\u{61C}\\u{200E}\\u{200F}');
    expect(output).toContain('\n2 │     return text;');
  });

  it('expands tabs to 4-column stops so code stays aligned', () => {
    expect(codeBlockLines(off, preview('\tx\nab\ty\n\t\tz')).slice(1)).toEqual(['1 │     x', '2 │ ab  y', '3 │         z']);
    expect(body('\tif (a)\t{}')).toEqual(['    if (a)  {}']);
  });
});

describe('codeBlockLines highlighting', () => {
  const comment = on.dim;
  const str = on.green;
  const num = on.yellow;
  const kw = on.magenta;

  it('colours a line comment to the end of the line', () => {
    expect(painted('x = 1; // note "q"')[0]).toContain(comment('// note "q"'));
  });

  it('carries a block comment across lines', () => {
    const [first, middle, last] = painted('a /* one\ntwo if\nthree */ b');
    expect(first).toContain(comment('/* one'));
    expect(middle).toBe(comment('two if'));
    expect(last).toBe(`${comment('three */')} b`);
  });

  it('closes a one-line block comment before the code that follows', () => {
    expect(painted('/* c */ return x;')[0]).toBe(`${comment('/* c */')} ${kw('return')} x;`);
  });

  it('keeps an escaped quote inside the string', () => {
    expect(painted('f("a\\"b", c)')[0]).toBe(`f(${str('"a\\"b"')}, c)`);
  });

  it('ends a string whose last character is an escaped backslash', () => {
    expect(painted('f("a\\\\", if1)')[0]).toBe(`f(${str('"a\\\\"')}, if1)`);
  });

  it('colours an unterminated string to the end of the line and recovers on the next', () => {
    expect(painted('x = "open\nreturn 1')).toEqual([`x = ${str('"open')}`, `${kw('return')} ${num('1')}`]);
    expect(painted('"\\')).toEqual([str('"\\')]);
  });

  it('colours keywords but not identifiers that contain them', () => {
    expect(painted('if (iffy) return format(x);')[0]).toBe(`${kw('if')} (iffy) ${kw('return')} format(x);`);
  });

  it('colours numbers', () => {
    expect(painted('x = 42 + 3.14;')[0]).toBe(`x = ${num('42')} + ${num('3.14')};`);
  });

  it('keeps colouring aligned after tab expansion', () => {
    expect(painted('\tconst a = 1;')[0]).toBe(`    ${kw('const')} a = ${num('1')};`);
  });

  describe('rust', () => {
    it('treats lifetimes as lifetimes, not strings', () => {
      const [line] = painted("fn f<'a>(x: &'a str) -> &'a str", 'rust');
      expect(line).toBe(`${kw('fn')} f<${kw("'a")}>(x: &${kw("'a")} str) -> &${kw("'a")} str`);
      expect(line).not.toContain(`${ESC}[32m`);
      expect(painted("'outer: loop {}", 'rust')[0]).toBe(`${kw("'outer")}: ${kw('loop')} {}`);
      expect(painted("&'static str", 'rust')[0]).toBe(`&${kw("'static")} str`);
    });

    it('still colours char literals as strings', () => {
      expect(painted("let c = 'x';", 'rust')[0]).toBe(`${kw('let')} c = ${str("'x'")};`);
      expect(painted("['\\n', '\\'', '\\u{1F600}']", 'rust')[0]).toBe(`[${str("'\\n'")}, ${str("'\\''")}, ${str("'\\u{1F600}'")}]`);
    });
  });

  describe('python', () => {
    it('carries a triple-quoted docstring across lines', () => {
      const lines = painted('"""Doc\nmore if\nend""" if x', 'python');
      expect(lines).toEqual([str('"""Doc'), str('more if'), `${str('end"""')} ${kw('if')} x`]);
    });

    it("tracks ''' and escapes inside it", () => {
      expect(painted("'''a\\'''\nb''' + 1", 'python')).toEqual([str("'''a\\'''"), `${str("b'''")} + ${num('1')}`]);
    });

    it('closes a one-line triple-quoted string', () => {
      expect(painted('x = """x""" or 1', 'python')[0]).toBe(`x = ${str('"""x"""')} ${kw('or')} ${num('1')}`);
    });
  });
});
