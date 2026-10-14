// The map as a tree of display nodes: repo > module > file > group/symbol, each
// with its computed state. Renderer-agnostic (CLI heat map, `--json`, MCP, web)
// and holds no answer data (only question counts).
import type { Chunk, ChunkKind } from '../model/chunk.js';
import type { ChunkColor, ChunkState } from '../model/progress.js';

export interface MapNode {
  id: string;
  kind: ChunkKind;
  title: string;
  /** File path for files and their descendants; null for modules. */
  path: string | null;
  /** 1-based inclusive line span inside `path`; null for modules and files. */
  lines: { start: number; end: number } | null;
  loc: number;
  complexity: number;
  fanIn: number;
  isLeaf: boolean;
  /** Questions per quiz session (leaves only, else 0). */
  questionCount: number;
  /** Usable questions in the pool: `ok`, not flagged, generated against the current hash (leaves only). >0 means not grey. */
  okQuestions: number;
  state: { color: ChunkColor; R: number | null; dueAt: string | null };
  children: MapNode[];
}

const KIND_ORDER: Record<ChunkKind, number> = { module: 0, file: 1, group: 2, symbol: 2 };

export function buildMapTree(
  chunks: readonly Chunk[],
  states: ReadonlyMap<string, ChunkState>,
  okQuestions: ReadonlyMap<string, number>,
): MapNode | null {
  const byParent = new Map<string | null, Chunk[]>();
  for (const c of chunks) {
    const list = byParent.get(c.parentId);
    if (list) list.push(c);
    else byParent.set(c.parentId, [c]);
  }
  const toNode = (c: Chunk): MapNode => {
    const state = states.get(c.id) ?? { R: null, color: 'grey' as const };
    const range = c.ranges[0];
    const kids = [...(byParent.get(c.id) ?? [])].sort(compareSiblings);
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      path: c.kind === 'module' ? null : (range?.path ?? null),
      lines: c.kind === 'module' || c.kind === 'file' || !range ? null : { start: range.start, end: range.end },
      loc: c.metrics.loc,
      complexity: c.metrics.complexity,
      fanIn: c.metrics.fanIn,
      isLeaf: c.isLeaf,
      questionCount: c.questionCount,
      okQuestions: okQuestions.get(c.id) ?? 0,
      state: { color: state.color, R: state.R, dueAt: state.dueAt ?? null },
      children: kids.map(toNode),
    };
  };
  const root = byParent.get(null)?.[0];
  return root ? toNode(root) : null;
}

function compareSiblings(a: Chunk, b: Chunk): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  if (a.kind === 'group' || a.kind === 'symbol') {
    const d = (a.ranges[0]?.start ?? 0) - (b.ranges[0]?.start ?? 0);
    if (d !== 0) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether chunk `id` is `filter` itself or lies below it (directory, file or symbol prefix). */
export function matchesFilter(id: string, filter: string): boolean {
  if (filter === '.' || id === filter) return true;
  if (filter.includes('#')) return id.startsWith(`${filter}.`); // nested symbols
  return id.startsWith(`${filter}/`) || id.startsWith(`${filter}#`);
}

/**
 * Keeps nodes matching `filter` (with their full subtrees) and the ancestors leading
 * to them. Ancestor aggregates are left as computed for the whole tree. Null if nothing matches.
 */
export function filterTree(node: MapNode, filter: string): MapNode | null {
  if (matchesFilter(node.id, filter)) return node;
  const children = node.children.map((c) => filterTree(c, filter)).filter((c): c is MapNode => c !== null);
  return children.length > 0 ? { ...node, children } : null;
}
