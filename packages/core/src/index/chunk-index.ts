// In-memory chunk index (PLAN.md §7): file path + line → deepest chunk in
// O(log n). Must not import web-tree-sitter or anything under parse/.
import type { Chunk } from '../model/chunk.js';
import { toPosixPath } from '../model/ids.js';

interface Interval {
  start: number;
  end: number;
  depth: number;
  chunk: Chunk;
}

interface FileEntry {
  /** Sorted by start, then end. */
  intervals: Interval[];
  /** prefixMaxEnd[i] = max end over intervals[0..i]; lets lookups stop early. */
  prefixMaxEnd: Int32Array;
}

export class ChunkIndex {
  private readonly byId = new Map<string, Chunk>();
  private readonly childIds = new Map<string, string[]>();
  private readonly files = new Map<string, FileEntry>();
  private readonly fileChunks = new Map<string, Chunk>();

  constructor(chunks: readonly Chunk[]) {
    for (const c of chunks) {
      this.byId.set(c.id, c);
      if (c.parentId !== null) {
        const list = this.childIds.get(c.parentId);
        if (list) list.push(c.id);
        else this.childIds.set(c.parentId, [c.id]);
      }
      if (c.kind === 'file') this.fileChunks.set(c.id, c);
    }
    const buckets = new Map<string, Interval[]>();
    for (const c of chunks) {
      if (c.kind === 'module') continue;
      const depth = this.depthOf(c);
      for (const r of c.ranges) {
        const list = buckets.get(r.path) ?? [];
        list.push({ start: r.start, end: r.end, depth, chunk: c });
        buckets.set(r.path, list);
      }
    }
    for (const [path, intervals] of buckets) {
      intervals.sort((a, b) => a.start - b.start || a.end - b.end);
      const prefixMaxEnd = new Int32Array(intervals.length);
      let max = 0;
      intervals.forEach((iv, i) => {
        max = Math.max(max, iv.end);
        prefixMaxEnd[i] = max;
      });
      this.files.set(path, { intervals, prefixMaxEnd });
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Chunk | undefined {
    return this.byId.get(id);
  }

  children(id: string): Chunk[] {
    return (this.childIds.get(id) ?? []).map((c) => this.byId.get(c)!);
  }

  /** The file chunk for a repo-relative path. */
  fileChunk(path: string): Chunk | undefined {
    return this.fileChunks.get(toPosixPath(path));
  }

  /** Leaves under a chunk (the chunk itself if it is a leaf). */
  leavesUnder(id: string): Chunk[] {
    const root = this.byId.get(id);
    if (!root) return [];
    const out: Chunk[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (c.isLeaf) out.push(c);
      else stack.push(...this.children(c.id).reverse());
    }
    return out;
  }

  /**
   * Deepest chunk whose ranges contain `line` (1-based) in `path`; ties go to
   * the narrower range. Lines outside every symbol fall back to the file chunk.
   */
  lookup(path: string, line: number): Chunk | undefined {
    const p = toPosixPath(path);
    const entry = this.files.get(p);
    if (!entry) return undefined;
    const { intervals, prefixMaxEnd } = entry;
    // Last interval with start <= line.
    let lo = 0;
    let hi = intervals.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid]!.start <= line) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let best: Interval | undefined;
    for (let i = idx; i >= 0 && prefixMaxEnd[i]! >= line; i--) {
      const iv = intervals[i]!;
      if (iv.end < line) continue;
      if (!best || iv.depth > best.depth || (iv.depth === best.depth && iv.end - iv.start < best.end - best.start)) best = iv;
    }
    return best?.chunk ?? this.fileChunks.get(p);
  }

  private depthOf(c: Chunk): number {
    let depth = 0;
    let parent = c.parentId;
    while (parent !== null && depth < 1000) {
      depth++;
      parent = this.byId.get(parent)?.parentId ?? null;
    }
    return depth;
  }
}
