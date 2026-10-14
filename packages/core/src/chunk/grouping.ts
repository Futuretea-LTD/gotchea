// Leaf shaping (PLAN.md §5 "Chunk tree"): small adjacent siblings merge into
// groups, oversized symbols split into sub-symbols plus a `~body` remainder.
// Pure: works on normalized lines and a symbol tree, no tree-sitter here.
import type { ChunkingConfig } from '../config/schema.js';
import { linesInRanges } from '../hash/normalize.js';
import type { LineRange } from '../model/chunk.js';
import { BODY_SEGMENT, TOP_SEGMENT, baseSymbolName, groupSegment } from '../model/ids.js';
import type { SymbolNode } from '../parse/parser.js';
import type { ChunkDraft, FileDraft } from './chunker.js';

export interface DraftContext {
  path: string;
  /** Normalized content per physical line (index 0 = line 1), '' for blank/comment lines. */
  fileLines: readonly string[];
  /** 1 + decision nodes starting in [start, end]. */
  complexity(start: number, end: number): number;
  cfg: ChunkingConfig;
}

interface Span {
  start: number;
  end: number;
}

/** Builds the root draft for a file: a leaf if small, else symbols + `~top`. */
export function buildFileDraft(ctx: DraftContext, symbols: readonly SymbolNode[], lang?: string): FileDraft {
  const lineCount = ctx.fileLines.length;
  const whole: Span = { start: 1, end: Math.max(1, lineCount) };
  const normalizedLines = linesInRanges(ctx.fileLines, [whole]);
  const file: FileDraft = {
    kind: 'file',
    symbolPath: [],
    title: basename(ctx.path),
    ranges: [{ path: ctx.path, ...whole }],
    normalizedLines,
    complexity: ctx.complexity(whole.start, whole.end),
    children: [],
    ...(lang === undefined ? {} : { lang }),
  };
  if (normalizedLines.length <= ctx.cfg.leafMaxLoc) return file;

  const children = buildChildren(ctx, symbols, [], whole, TOP_SEGMENT, '(top level)');
  // A lone leaf child would just duplicate the file; keep the file as the leaf.
  if (children.length > 1 || (children.length === 1 && children[0]!.children.length > 0)) file.children = children;
  return file;
}

/** Siblings for `symbols` under `parentPath`, plus the uncovered remainder of `span`. */
function buildChildren(
  ctx: DraftContext,
  symbols: readonly SymbolNode[],
  parentPath: readonly string[],
  span: Span,
  remainderSegment: string,
  remainderTitle: string,
): ChunkDraft[] {
  const segments = assignSegments(symbols);
  const drafts = symbols.map((s, i) => buildSymbolDraft(ctx, s, [...parentPath, segments[i]!]));
  const out = groupSiblings(drafts, ctx.cfg, parentPath);
  const rest = remainderRanges(span, symbols, ctx.fileLines);
  if (rest.length > 0) {
    out.push({
      kind: 'symbol',
      symbolPath: [...parentPath, remainderSegment],
      title: remainderTitle,
      ranges: rest.map((r) => ({ path: ctx.path, ...r })),
      normalizedLines: linesInRanges(ctx.fileLines, rest),
      complexity: sumComplexity(rest.map((r) => ctx.complexity(r.start, r.end))),
      children: [],
    });
  }
  return out;
}

function buildSymbolDraft(ctx: DraftContext, s: SymbolNode, symbolPath: string[]): ChunkDraft {
  const span: Span = { start: s.start, end: s.end };
  const normalizedLines = linesInRanges(ctx.fileLines, [span]);
  const draft: ChunkDraft = {
    kind: 'symbol',
    symbolPath,
    title: s.name,
    ranges: [{ path: ctx.path, ...span }],
    normalizedLines,
    complexity: ctx.complexity(span.start, span.end),
    children: [],
  };
  if (normalizedLines.length > ctx.cfg.splitAboveLoc && s.children.length > 0) {
    draft.children = buildChildren(ctx, s.children, symbolPath, span, BODY_SEGMENT, `${s.name} (body)`);
  }
  return draft;
}

/** Segment per symbol: the sanitized name, with `@2`, `@3` for repeats in source order. */
export function assignSegments(symbols: readonly Pick<SymbolNode, 'name'>[]): string[] {
  const seen = new Map<string, number>();
  return symbols.map((s) => {
    const base = sanitizeSegment(s.name);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}@${n}`;
  });
}

/**
 * Segments are NFC and must not contain the id separators `.`/`#`, whitespace or
 * the duplicate marker `@`, nor start with `~` (reserved for `~top`, `~body`,
 * `~group:`), so a real name like `declare module 'a@2'` can never collide with a
 * synthetic segment.
 */
export function sanitizeSegment(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\s.#@]+/g, '_').replace(/^~/, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * Greedily merges adjacent leaf siblings below `mergeBelowLoc` until the group
 * reaches `leafMinLoc` or the next member would exceed `leafMaxLoc`. A group
 * with a single member stays a plain symbol.
 */
export function groupSiblings(drafts: readonly ChunkDraft[], cfg: ChunkingConfig, parentPath: readonly string[]): ChunkDraft[] {
  const small = (d: ChunkDraft) => d.children.length === 0 && d.normalizedLines.length < cfg.mergeBelowLoc;
  const out: ChunkDraft[] = [];
  let i = 0;
  while (i < drafts.length) {
    const first = drafts[i]!;
    i++;
    if (!small(first)) {
      out.push(first);
      continue;
    }
    const members = [first];
    let loc = first.normalizedLines.length;
    while (i < drafts.length) {
      const next = drafts[i]!;
      if (!small(next) || loc >= cfg.leafMinLoc || loc + next.normalizedLines.length > cfg.leafMaxLoc) break;
      members.push(next);
      loc += next.normalizedLines.length;
      i++;
    }
    out.push(members.length === 1 ? first : makeGroup(members, parentPath));
  }
  return out;
}

function makeGroup(members: readonly ChunkDraft[], parentPath: readonly string[]): ChunkDraft {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const firstSegment = first.symbolPath[first.symbolPath.length - 1]!;
  return {
    kind: 'group',
    symbolPath: [...parentPath, groupSegment(firstSegment)],
    title: `${first.title} … ${last.title} (${members.length})`,
    ranges: mergeAdjacent(members.flatMap((m) => m.ranges)),
    normalizedLines: members.flatMap((m) => m.normalizedLines),
    complexity: sumComplexity(members.map((m) => m.complexity)),
    children: [],
    members: members.map((m) => [...m.symbolPath]),
  };
}

/** Complexity of a union: 1 + the decision nodes of each part. */
function sumComplexity(parts: readonly number[]): number {
  return parts.reduce((acc, c) => acc + (c - 1), 1);
}

/** Joins ranges of the same path that touch (end + 1 === start). */
export function mergeAdjacent(ranges: readonly LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && prev.path === r.path && prev.end + 1 >= r.start && r.start >= prev.start) prev.end = Math.max(prev.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Lines of `span` not covered by `covered` that have content, as ranges. Blank
 * lines inside a run are absorbed; covered lines break it.
 */
export function remainderRanges(span: Span, covered: readonly Span[], fileLines: readonly string[]): Span[] {
  const end = Math.min(span.end, fileLines.length);
  const isCovered = new Uint8Array(end + 2);
  for (const c of covered) {
    for (let l = Math.max(span.start, c.start); l <= Math.min(end, c.end); l++) isCovered[l] = 1;
  }
  const out: Span[] = [];
  let current: Span | null = null;
  for (let l = Math.max(1, span.start); l <= end; l++) {
    if (isCovered[l]) {
      current = null;
      continue;
    }
    if (!fileLines[l - 1]) continue;
    if (current) current.end = l;
    else {
      current = { start: l, end: l };
      out.push(current);
    }
  }
  return out;
}

/** Top-level symbol names a draft stands for (groups: every member), for fanIn. */
export function draftSymbolPaths(d: ChunkDraft): string[][] {
  if (d.members) return d.members.map((m) => m.map(baseSymbolName));
  return [d.symbolPath.map(baseSymbolName)];
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
