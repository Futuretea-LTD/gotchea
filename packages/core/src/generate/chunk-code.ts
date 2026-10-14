// Numbered chunk code and chunk-relative line refs (M2_DESIGN.md §2.3, decision D1).
// Line 1 is the chunk's first line, numbering runs over `chunk.ranges` without gaps,
// and absolute lines are only ever computed at display time.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Chunk } from '../model/chunk.js';

/** Unnumbered marker rendered between the ranges of a multi-range chunk. */
export const RANGE_SEPARATOR = '┆';

export interface ChunkCode {
  /** Raw source lines over all ranges, in order: index i is chunk line i + 1. */
  lines: string[];
  lineCount: number;
  /** `<right-aligned n> | <raw line>`, with an unnumbered separator between ranges. */
  numbered: string;
}

/** `Σ (end − start + 1)` over the chunk's ranges. */
export function chunkLineCount(chunk: Pick<Chunk, 'ranges'>): number {
  return chunk.ranges.reduce((n, r) => n + Math.max(0, r.end - r.start + 1), 0);
}

/** Numbers raw lines (one array per range) from 1. Tabs and trailing text are kept verbatim. */
export function numberChunkCode(rangeLines: readonly (readonly string[])[]): ChunkCode {
  const lines = rangeLines.flat();
  const width = String(Math.max(lines.length, 1)).length;
  const out: string[] = [];
  let n = 0;
  rangeLines.forEach((range, i) => {
    if (i > 0) out.push(`${' '.repeat(width)} ${RANGE_SEPARATOR}`);
    for (const line of range) out.push(`${String(++n).padStart(width)} | ${line}`);
  });
  return { lines, lineCount: lines.length, numbered: out.join('\n') };
}

/** Splits a file into raw lines (LF or CRLF, BOM dropped). */
export function splitSourceLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

/** Reads the chunk's ranges from the working tree under `root` and numbers them. */
export async function readChunkCode(root: string, chunk: Pick<Chunk, 'ranges'>): Promise<ChunkCode> {
  const files = new Map<string, string[]>();
  const rangeLines: string[][] = [];
  for (const r of chunk.ranges) {
    let lines = files.get(r.path);
    if (!lines) {
      lines = splitSourceLines(await readFile(join(root, r.path), 'utf8'));
      files.set(r.path, lines);
    }
    rangeLines.push(lines.slice(r.start - 1, r.end));
  }
  return numberChunkCode(rangeLines);
}

/**
 * Maps a 1-based chunk-relative line to its current file position by walking
 * `chunk.ranges`; null when it lies outside the chunk. For a single-range chunk
 * this is `ranges[0].start + ref − 1`.
 */
export function toAbsoluteLine(chunk: Pick<Chunk, 'ranges'>, ref: number): { path: string; line: number } | null {
  if (!Number.isInteger(ref) || ref < 1) return null;
  let left = ref;
  for (const r of chunk.ranges) {
    const size = Math.max(0, r.end - r.start + 1);
    if (left <= size) return { path: r.path, line: r.start + left - 1 };
    left -= size;
  }
  return null;
}
