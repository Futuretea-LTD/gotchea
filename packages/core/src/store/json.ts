// Deterministic JSON serialization: pretty (2 spaces) + trailing newline.
import { compareCodeUnits } from '../hash/hash.js';
import type { Chunk, ChunksFile, LineRange } from '../model/chunk.js';

export { compareCodeUnits };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort(compareCodeUnits)) out[k] = sortKeysDeep(value[k]);
  return out;
}

/**
 * Pretty JSON with a trailing newline. With `sortKeys`, object keys are sorted
 * recursively; without, the caller's key order is kept (already canonical).
 */
export function canonicalJson(value: unknown, opts: { sortKeys: boolean }): string {
  const v = opts.sortKeys ? sortKeysDeep(value) : value;
  return `${JSON.stringify(v, null, 2)}\n`;
}

/** `canonicalJson(value, { sortKeys: true })`. */
export function stableStringify(value: unknown): string {
  return canonicalJson(value, { sortKeys: true });
}

function canonicalRange(r: LineRange): LineRange {
  return { path: r.path, start: r.start, end: r.end };
}

/** A chunk with the fixed on-disk key order; undefined optionals are omitted. */
export function canonicalChunk(c: Chunk): Chunk {
  const out: Record<string, unknown> = {
    id: c.id,
    kind: c.kind,
    parentId: c.parentId,
    title: c.title,
    source: c.source,
  };
  if (c.lang !== undefined) out['lang'] = c.lang;
  out['isLeaf'] = c.isLeaf;
  out['ranges'] = c.ranges.map(canonicalRange);
  out['contentHash'] = c.contentHash;
  out['metrics'] = { loc: c.metrics.loc, complexity: c.metrics.complexity, fanIn: c.metrics.fanIn };
  out['questionCount'] = c.questionCount;
  if (c.aliases !== undefined) out['aliases'] = [...c.aliases];
  return out as unknown as Chunk;
}

/** `chunks.json` content: chunks sorted by id, fixed key order, byte-identical for equal input. */
export function serializeChunksFile(file: ChunksFile): string {
  const chunks = [...file.chunks].sort((a, b) => compareCodeUnits(a.id, b.id)).map(canonicalChunk);
  return canonicalJson({ version: file.version, normalization: file.normalization, chunks }, { sortKeys: false });
}
