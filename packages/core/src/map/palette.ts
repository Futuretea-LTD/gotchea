// The one heatmap colour function and its renderers (M3_DESIGN.md §9). Thresholds are
// applied only by `colorFor`; this module maps a real retrievability to a colour and a
// colour to presentation data. CLI and MCP both render through it.
import type { ScoreConfig } from '../config/schema.js';
import type { ChunkColor } from '../model/progress.js';
import { colorFor } from '../score/state.js';

export type AnsiColorName = 'gray' | 'red' | 'yellow' | 'green';

export const HEAT: Record<ChunkColor, { emoji: string; ansi: AnsiColorName; label: string }> = {
  grey: { emoji: '⬜', ansi: 'gray', label: 'no questions' },
  red: { emoji: '🟥', ansi: 'red', label: 'red' },
  yellow: { emoji: '🟨', ansi: 'yellow', label: 'yellow' },
  green: { emoji: '🟩', ansi: 'green', label: 'green' },
};

/** Display order, worst first. */
export const HEAT_COLORS: readonly ChunkColor[] = ['red', 'yellow', 'green', 'grey'];

const ANSI_CODE: Record<AnsiColorName, number> = { red: 31, green: 32, yellow: 33, gray: 90 };

/** Heat colour of a retrievability: null (no questions) is grey, 0 (never passed) is red. */
export function heatColor(R: number | null, cfg: Pick<ScoreConfig, 'greenAt' | 'yellowAt'>): ChunkColor {
  return colorFor(R, { neverPassed: false, mustRepass: false, hasQuestions: R !== null }, cfg);
}

/** Wraps `text` in the ANSI colour of `color`. */
export function ansiPaint(color: ChunkColor, text: string): string {
  return `\u001b[${ANSI_CODE[HEAT[color].ansi]}m${text}\u001b[39m`;
}

/** One heatmap cell: an ANSI-coloured dot for terminals, an emoji square for MCP text. */
export function renderHeatCell(color: ChunkColor, mode: 'ansi' | 'emoji'): string {
  return mode === 'emoji' ? HEAT[color].emoji : ansiPaint(color, '●');
}
