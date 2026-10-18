// Text from the working tree or a hand-editable chunks.json ends up in a terminal (CLI quiz) and
// in agent context (MCP). Raw control characters there could move the cursor, rewrite earlier
// output or plant OSC 8 links; bidi overrides could make code read differently than it runs
// (Trojan Source, CVE-2021-42574). Each one is swapped for a visible stand-in instead.
// Escapes only, never the characters themselves: a literal bidi control in this file would be the
// very trick it guards against, and is flagged by GitHub and by editors.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNSAFE = /\r\n?|[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function standIn(ch: string): string {
  if (ch === '\r\n') return '\n';
  const code = ch.codePointAt(0)!;
  if (code <= 0x1f) return String.fromCodePoint(0x2400 + code);
  if (code === 0x7f) return '␡';
  if (code <= 0x9f) return '�';
  return `\\u{${code.toString(16).toUpperCase()}}`;
}

/** Keeps tab and newline, folds CRLF to LF, and replaces every other control or bidi character with a visible stand-in. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(UNSAFE, standIn);
}
