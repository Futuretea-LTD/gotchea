// Normalization `n1` (PLAN.md §4): comments blanked, whitespace collapsed,
// blank lines dropped. Reformatting or comment-only edits keep the hash.
import type { OffsetRange } from '../parse/parser.js';

export const NORMALIZATION_VERSION = 'n1' as const;

/** CRLF/CR → LF and BOM stripped. Offsets from a parser must refer to this text. */
export function canonicalText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

/** Replaces every comment character with a space, keeping newlines so lines stay aligned. */
export function blankRanges(text: string, ranges: readonly OffsetRange[]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    const start = Math.max(pos, r.start);
    const end = Math.min(text.length, r.end);
    if (end <= start) continue;
    out += text.slice(pos, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
    pos = end;
  }
  return out + text.slice(pos);
}

/** Trims a line and collapses runs of spaces/tabs. */
export function normalizeLine(line: string): string {
  return line.trim().replace(/[ \t]+/g, ' ');
}

/**
 * Normalized content per physical line (index 0 = line 1). Blank and
 * comment-only lines map to ''. `text` must already be `canonicalText`.
 */
export function normalizeFileLines(text: string, comments: readonly OffsetRange[]): string[] {
  const lines = blankRanges(text, comments).split('\n');
  // A trailing newline ends the last line; it does not start a new one.
  if (lines.length > 1 && text.endsWith('\n')) lines.pop();
  return lines.map(normalizeLine);
}

/** Non-empty normalized lines for 1-based inclusive line ranges, in range order. */
export function linesInRanges(fileLines: readonly string[], ranges: readonly { start: number; end: number }[]): string[] {
  const out: string[] = [];
  for (const r of ranges) {
    const end = Math.min(r.end, fileLines.length);
    for (let i = Math.max(1, r.start); i <= end; i++) {
      const line = fileLines[i - 1];
      if (line) out.push(line);
    }
  }
  return out;
}

/** Normalizes a source string end to end (canonical text → blank comments → drop blanks). */
export function normalizeSource(text: string, comments: readonly OffsetRange[] = []): string[] {
  return normalizeFileLines(canonicalText(text), comments).filter((l) => l.length > 0);
}
