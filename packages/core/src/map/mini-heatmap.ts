// The small heatmap shown after a quiz (M3_DESIGN.md §9.3): the focus chunk, its siblings in
// the file and its ancestors. Pure; the states come from the same `computeTreeStates` call
// that backs `get_map`, so the two always agree.
import type { Chunk, ChunkKind } from '../model/chunk.js';
import type { ChunkColor, ChunkState } from '../model/progress.js';
import { sanitizeTerminalText } from '../quiz/sanitize.js';
import { HEAT, ansiPaint } from './palette.js';

const MAX_FILE_LEAVES = 12;

type Cell = { id: string; title: string; color: ChunkColor; R: number | null };

export interface MiniHeatmap {
  focus: Cell & { path: string | null };
  /** Leaves of the focus chunk's file in line order; at most 12 (the focus is always kept), `omitted` counts the rest. */
  fileLeaves: (Cell & { isFocus: boolean })[];
  omitted: number;
  /** Nearest first: the file, then modules up to the repo root. */
  ancestors: (Cell & { kind: ChunkKind })[];
}

type MiniChunk = Pick<Chunk, 'id' | 'parentId' | 'kind' | 'title' | 'isLeaf' | 'ranges'>;

export function buildMiniHeatmap(chunks: readonly MiniChunk[], states: ReadonlyMap<string, Pick<ChunkState, 'R' | 'color'>>, chunkId: string): MiniHeatmap {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const focus = byId.get(chunkId);
  if (!focus) throw new Error(`Unknown chunk ${chunkId}`);
  const cell = (c: MiniChunk): Cell => ({ id: c.id, title: c.title, color: states.get(c.id)?.color ?? 'grey', R: states.get(c.id)?.R ?? null });

  const ancestors: MiniHeatmap['ancestors'] = [];
  for (let p = focus.parentId === null ? undefined : byId.get(focus.parentId); p; p = p.parentId === null ? undefined : byId.get(p.parentId)) {
    ancestors.push({ ...cell(p), kind: p.kind });
  }
  const file = ancestors.find((a) => a.kind === 'file');

  const under = (id: string): boolean => {
    for (let p = byId.get(id); p; p = p.parentId === null ? undefined : byId.get(p.parentId)) if (p.id === file?.id) return true;
    return false;
  };
  const leaves = chunks
    .filter((c) => c.isLeaf && (file ? under(c.id) : c.id === focus.id))
    .sort((a, b) => (a.ranges[0]?.start ?? 0) - (b.ranges[0]?.start ?? 0) || (a.id < b.id ? -1 : 1));
  let shown = leaves;
  if (leaves.length > MAX_FILE_LEAVES) {
    const at = leaves.findIndex((c) => c.id === focus.id);
    const start = Math.max(0, Math.min(at - Math.floor(MAX_FILE_LEAVES / 2), leaves.length - MAX_FILE_LEAVES));
    shown = leaves.slice(start, start + MAX_FILE_LEAVES);
  }
  return {
    focus: { ...cell(focus), path: focus.ranges[0]?.path ?? null },
    fileLeaves: shown.map((c) => ({ ...cell(c), isFocus: c.id === focus.id })),
    omitted: leaves.length - shown.length,
    ancestors,
  };
}

const LETTER: Record<ChunkColor, string> = { grey: '-', red: 'R', yellow: 'Y', green: 'G' };

/**
 * `emoji` for MCP text, `ansi` for terminals, `plain` when colour is off (state then never
 * depends on colour alone: letter and R are printed). `paint` overrides the ANSI painter.
 */
export function renderMiniHeatmapText(h: MiniHeatmap, mode: 'emoji' | 'ansi' | 'plain', paint?: (c: ChunkColor) => (s: string) => string): string {
  const pct = (R: number | null): string => (R === null ? '' : ` ${Math.round(R * 100)}%`);
  const cell = (c: { color: ChunkColor; R: number | null }, raw: string): string => {
    // Titles come from hand-editable chunks.json and are printed to a terminal or agent context.
    const label = sanitizeTerminalText(raw);
    if (mode === 'emoji') return `${HEAT[c.color].emoji} ${label}`;
    if (mode === 'plain') return `[${LETTER[c.color]}${pct(c.R)}] ${label}`;
    return `${(paint?.(c.color) ?? ((s) => ansiPaint(c.color, s)))('●')} ${label}`;
  };
  const row = h.fileLeaves.map((l) => `${l.isFocus ? '► ' : ''}${cell(l, l.title)}`).join('   ');
  const more = h.omitted > 0 ? `   (+${h.omitted} more)` : '';
  const lines = [`${row}${more}`];
  if (h.ancestors.length > 0) lines.push(`Up: ${h.ancestors.map((a) => cell(a, a.title)).join(' · ')}`);
  return lines.join('\n');
}
