// Terminal text for `gotchea quiz`. The question text comes from the public view; the reveal text
// is only ever built from a `RevealView`, i.e. after the answer was recorded. Stored question text
// is hand-editable, so it is sanitized here, at the last stop before the terminal.
import { HEAT, LABELS, renderMiniHeatmapText, sanitizeTerminalText, type PublicQuestionView, type RevealView, type ScoreConfig, type SessionResultView } from 'gotchea-core';
import type { Colors } from '../context.js';
import { formatScore, paintFor } from './tree-heatmap.js';

export function questionHeader(pc: Colors, q: PublicQuestionView): string {
  return pc.bold(`Question ${q.position} of ${q.total}`);
}

function formatRefs(refs: RevealView['refs']): string {
  return refs.map((r) => `${sanitizeTerminalText(r.path)} ${r.approximate ? '≈ ' : ''}${r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}–L${r.endLine}`}`).join(', ');
}

export function revealLines(pc: Colors, r: RevealView): string[] {
  const lines = [r.correct ? pc.green('✅ Correct.') : pc.red(`❌ Incorrect. You chose ${LABELS[r.selectedDisplayIndex]}.`)];
  if (!r.correct) lines.push(`Correct answer: ${LABELS[r.correctDisplayIndex]}) ${sanitizeTerminalText(r.correctText)}`);
  lines.push(`Explanation: ${sanitizeTerminalText(r.explanation)}`);
  if (r.refs.length > 0) lines.push(pc.dim(`Look at: ${formatRefs(r.refs)}`));
  return lines;
}

/** Final chunk colour and the ANSI heatmap; with colours off, letters and percentages carry the state. */
export function resultLines(pc: Colors, res: SessionResultView, cfg: Pick<ScoreConfig, 'greenAt'>): string[] {
  const { before, after, chunk } = res;
  const dot = (c: typeof before.color) => (pc.isColorSupported ? paintFor(pc, c)('●') : `[${HEAT[c].label}]`);
  const verdict = res.passed ? pc.green('PASSED') : pc.red('NOT PASSED');
  const name = sanitizeTerminalText(chunk.path ? `${chunk.path} › ${chunk.title}` : chunk.title);
  return [
    '',
    `Quiz complete: ${res.correct}/${res.total} correct (needed ${res.needed}) — ${verdict}`,
    `${name}: ${dot(before.color)} → ${dot(after.color)}  (R ${formatScore(before.R)} → ${formatScore(after.R)})${after.dueAt ? ` · green until ${after.dueAt.slice(0, 10)}` : ''}`,
    res.passed ? `Next review is due when retrievability falls below ${Math.round(cfg.greenAt * 100)}%.` : 'This chunk must be passed again; it stays red until then.',
    '',
    `Heatmap (${sanitizeTerminalText(chunk.path ?? chunk.title)}):`,
    renderMiniHeatmapText(res.heatmap, pc.isColorSupported ? 'ansi' : 'plain', (c) => paintFor(pc, c)),
  ];
}
