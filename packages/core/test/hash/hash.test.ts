import { describe, expect, it } from 'vitest';
import { compareCodeUnits, contentHash, fnv1a32, lineFingerprints, moduleHash } from '../../src/hash/hash.js';
import {
  blankRanges,
  canonicalText,
  linesInRanges,
  normalizeFileLines,
  normalizeLine,
  normalizeSource,
} from '../../src/hash/normalize.js';

describe('normalize (n1)', () => {
  it('canonicalizes CRLF/CR and strips the BOM', () => {
    expect(canonicalText('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(canonicalText('plain')).toBe('plain');
  });

  it('blanks comment ranges but keeps newlines so lines stay aligned', () => {
    const text = 'a /* x\ny */ b\n// c\nd';
    const out = blankRanges(text, [
      { start: text.indexOf('// c'), end: text.indexOf('// c') + 4 },
      { start: 2, end: text.indexOf('*/') + 2 },
    ]);
    expect(out.split('\n')).toEqual(['a     ', '     b', '    ', 'd']);
  });

  it('ignores empty, overlapping and out-of-bounds ranges', () => {
    expect(blankRanges('abcdef', [])).toBe('abcdef');
    expect(blankRanges('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 5, end: 99 }, { start: 3, end: 3 }])).toBe('a   e ');
  });

  it('trims lines and collapses runs of spaces and tabs', () => {
    expect(normalizeLine('\t  const   x =\t\t1;  ')).toBe('const x = 1;');
  });

  it('maps physical lines and selects non-empty lines in ranges', () => {
    const lines = normalizeFileLines('a\n\n  b  \n// c\n', [{ start: 9, end: 13 }]);
    // 4 physical lines: the final newline ends line 4, it does not start a line 5.
    expect(lines).toEqual(['a', '', 'b', '']);
    expect(normalizeFileLines('a', [])).toEqual(['a']);
    expect(normalizeFileLines('', [])).toEqual(['']);
    expect(linesInRanges(lines, [{ start: 1, end: 3 }])).toEqual(['a', 'b']);
    expect(linesInRanges(lines, [{ start: 0, end: 99 }])).toEqual(['a', 'b']);
    expect(linesInRanges(lines, [{ start: 3, end: 3 }, { start: 1, end: 1 }])).toEqual(['b', 'a']);
  });

  it('normalizeSource drops blank lines end to end', () => {
    expect(normalizeSource('x\r\n\r\n  y\t z ')).toEqual(['x', 'y z']);
  });
});

describe('hashes', () => {
  it('contentHash is 16 hex chars, versioned and order-sensitive', () => {
    const h = contentHash(['a', 'b']);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash(['a', 'b'])).toBe(h);
    expect(contentHash(['b', 'a'])).not.toBe(h);
    expect(contentHash(['a b'])).not.toBe(contentHash(['a', 'b']));
  });

  it('reformatting and comment edits keep the hash; token edits change it', () => {
    const v1 = normalizeSource('function f(a) {\n  return a + 1;\n}\n');
    const v2 = normalizeSource('\n\nfunction   f(a) {\r\n\t\treturn a + 1;\r\n}\r\n');
    const commented = 'function f(a) {\n  // explain\n  return a + 1;\n}\n';
    const start = commented.indexOf('//');
    const v3 = normalizeSource(commented, [{ start, end: start + '// explain'.length }]);
    const v4 = normalizeSource('function f(a) {\n  return a + 2;\n}\n');
    expect(contentHash(v2)).toBe(contentHash(v1));
    expect(contentHash(v3)).toBe(contentHash(v1));
    expect(contentHash(v4)).not.toBe(contentHash(v1));
  });

  it('moduleHash is independent of child order', () => {
    const a = { id: 'a', contentHash: '1' };
    const b = { id: 'b', contentHash: '2' };
    expect(moduleHash([a, b])).toBe(moduleHash([b, a]));
    expect(moduleHash([a])).not.toBe(moduleHash([a, b]));
    expect(moduleHash([])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('fnv1a32 matches reference vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
    expect(lineFingerprints(['a', ''])).toEqual(['e40c292c', '811c9dc5']);
  });

  it('compareCodeUnits is locale independent', () => {
    expect(['b', 'B', 'a', 'é'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b', 'é']);
    expect(compareCodeUnits('x', 'x')).toBe(0);
  });
});
