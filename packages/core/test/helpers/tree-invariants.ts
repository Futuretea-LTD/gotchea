// Structural invariants every scanned chunk tree must satisfy (PLAN.md §4, §5).
import { expect } from 'vitest';
import type { ChunkingConfig } from '../../src/config/schema.js';
import type { Chunk } from '../../src/model/chunk.js';
import { parentDir } from '../../src/model/ids.js';

export function byId(chunks: readonly Chunk[]): Map<string, Chunk> {
  return new Map(chunks.map((c) => [c.id, c]));
}

export function childrenOf(chunks: readonly Chunk[], id: string): Chunk[] {
  return chunks.filter((c) => c.parentId === id);
}

export function expectTreeInvariants(chunks: readonly Chunk[], cfg: ChunkingConfig): void {
  const map = byId(chunks);
  expect(map.size, 'ids are unique').toBe(chunks.length);
  expect(chunks.filter((c) => c.parentId === null).map((c) => c.id)).toEqual(['.']);

  for (const c of chunks) {
    const kids = childrenOf(chunks, c.id);
    expect(c.isLeaf, `${c.id}: isLeaf iff no children`).toBe(kids.length === 0);
    expect(c.questionCount > 0, `${c.id}: only leaves get questions`).toBe(c.isLeaf);
    if (c.parentId === null) continue;
    const parent = map.get(c.parentId);
    expect(parent, `${c.id}: parent ${c.parentId} exists`).toBeDefined();

    switch (c.kind) {
      case 'module':
        expect(parent!.kind).toBe('module');
        expect(c.parentId).toBe(parentDir(c.id));
        expect(c.ranges).toEqual([]);
        expect(c.isLeaf).toBe(false);
        break;
      case 'file':
        expect(parent!.kind).toBe('module');
        expect(c.parentId).toBe(parentDir(c.id));
        expect(c.ranges).toHaveLength(1);
        // Only files over leafMaxLoc get children.
        if (!c.isLeaf) expect(c.metrics.loc).toBeGreaterThan(cfg.leafMaxLoc);
        break;
      case 'group':
      case 'symbol': {
        expect(['file', 'symbol']).toContain(parent!.kind);
        expect(c.id.startsWith(parent!.kind === 'file' ? `${parent!.id}#` : `${parent!.id}.`), `${c.id} under ${parent!.id}`).toBe(true);
        const filePath = c.id.slice(0, c.id.indexOf('#'));
        for (const r of c.ranges) expect(r.path).toBe(filePath);
        // Children sit inside their parent's ranges.
        for (const r of c.ranges) {
          expect(parent!.ranges.some((p) => p.start <= r.start && r.end <= p.end), `${c.id} ${r.start}-${r.end} inside parent`).toBe(true);
        }
        if (c.kind === 'group') {
          expect(c.isLeaf).toBe(true);
          expect(c.id).toMatch(/~group:[^.]+$/);
          expect(c.metrics.loc).toBeLessThanOrEqual(cfg.leafMaxLoc);
        }
        // A split symbol must have exceeded splitAboveLoc.
        if (c.kind === 'symbol' && !c.isLeaf) expect(c.metrics.loc).toBeGreaterThan(cfg.splitAboveLoc);
        break;
      }
    }
  }

  // Modules aggregate LOC from their direct children.
  for (const m of chunks.filter((c) => c.kind === 'module')) {
    expect(m.metrics.loc).toBe(childrenOf(chunks, m.id).reduce((s, c) => s + c.metrics.loc, 0));
  }
}

/** Leaf ids of one file (excluding the file chunk itself unless it is the leaf). */
export function leavesOf(chunks: readonly Chunk[], path: string): Chunk[] {
  return chunks.filter((c) => c.isLeaf && (c.id === path || c.id.startsWith(`${path}#`)));
}
