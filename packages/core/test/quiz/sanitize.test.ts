import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeTerminalText } from '../../src/quiz/sanitize.js';

describe('sanitizeTerminalText', () => {
  it('returns an empty string unchanged', () => {
    expect(sanitizeTerminalText('')).toBe('');
  });

  it('keeps tab and newline', () => {
    expect(sanitizeTerminalText('a\tb\nc\n')).toBe('a\tb\nc\n');
  });

  it('folds CRLF to LF', () => {
    expect(sanitizeTerminalText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('replaces a lone CR with U+240D', () => {
    expect(sanitizeTerminalText('a\rb\r')).toBe('a␍b␍');
  });

  it('replaces other C0 characters with their control pictures', () => {
    expect(sanitizeTerminalText('\u0000')).toBe('␀');
    expect(sanitizeTerminalText('\u0007')).toBe('␇');
    expect(sanitizeTerminalText('\u000B\u000C')).toBe('␋␌');
    expect(sanitizeTerminalText('\u001B[31mred')).toBe('␛[31mred');
    expect(sanitizeTerminalText('\u001F')).toBe('␟');
  });

  it('neutralises an OSC 8 hyperlink', () => {
    expect(sanitizeTerminalText('\u001B]8;;http://evil\u0007x')).toBe('␛]8;;http://evil␇x');
  });

  it('replaces DEL with U+2421', () => {
    expect(sanitizeTerminalText('a\u007Fb')).toBe('a␡b');
  });

  it('replaces C1 characters with U+FFFD', () => {
    expect(sanitizeTerminalText('\u0080')).toBe('�');
    expect(sanitizeTerminalText('\u009B31m')).toBe('�31m');
    expect(sanitizeTerminalText('\u009F')).toBe('�');
  });

  it.each([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])('makes bidi control U+%s visible', (code) => {
    const hex = code.toString(16).toUpperCase();
    expect(sanitizeTerminalText(`a${String.fromCodePoint(code)}b`)).toBe(`a\\u{${hex}}b`);
  });

  it('neutralises every C0/C1 control except the intended tab and newline', () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code > 0x1f && code < 0x7f) continue;
      const ch = String.fromCodePoint(code);
      const safe = sanitizeTerminalText(ch);
      if (code === 9 || code === 10) expect(safe).toBe(ch);
      else expect(safe).not.toContain(ch);
    }
  });

  it('its own source holds no literal bidi control', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/quiz/sanitize.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
  });

  it('keeps a surrogate pair whole next to a stand-in', () => {
    expect(sanitizeTerminalText('🎉\u001B𝕏\u202E😀')).toBe('🎉␛𝕏\\u{202E}😀');
  });

  it('folds a CRLF at the very end and replaces a CR before a stand-in', () => {
    expect(sanitizeTerminalText('end\r\n')).toBe('end\n');
    expect(sanitizeTerminalText('a\r\u001Bb')).toBe('a␍␛b');
  });

  it('leaves ordinary non-ASCII text untouched', () => {
    const text = 'çağrı şimdi 🎉 漢字 👩‍💻  é';
    expect(sanitizeTerminalText(text)).toBe(text);
  });
});
