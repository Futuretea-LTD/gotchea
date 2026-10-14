// Colored tree view of a MapNode tree. Columns are aligned on the uncolored text,
// colors are applied afterwards.
import { HEAT, type ChunkColor, type MapNode, type ScoreConfig } from 'gotchea-core';
import type { Colors } from '../context.js';

interface Row {
  prefix: string;
  label: string;
  node: MapNode;
}

export function paintFor(pc: Colors, color: ChunkColor): (s: string) => string {
  return pc[HEAT[color].ansi];
}

export function formatScore(R: number | null): string {
  return R === null ? '–' : `${Math.round(R * 100)}%`;
}

function label(node: MapNode): string {
  return node.kind === 'module' ? `${node.title}/` : node.title;
}

function collect(node: MapNode, rows: Row[], indent: string, connector: string): void {
  rows.push({ prefix: indent + connector, label: label(node), node });
  const childIndent = indent + (connector === '' ? '' : connector === '├─ ' ? '│  ' : '   ');
  node.children.forEach((child, i) => {
    collect(child, rows, childIndent, i === node.children.length - 1 ? '└─ ' : '├─ ');
  });
}

export function renderHeatmap(root: MapNode, pc: Colors, cfg: Pick<ScoreConfig, 'greenAt' | 'yellowAt'>): string {
  const rows: Row[] = [];
  collect(root, rows, '', '');
  const nameWidth = Math.max(...rows.map((r) => r.prefix.length + 2 + r.label.length));
  const locWidth = Math.max(...rows.map((r) => String(r.node.loc).length));

  const lines = rows.map(({ prefix, label: text, node }) => {
    const paint = paintFor(pc, node.state.color);
    const pad = ' '.repeat(nameWidth - prefix.length - 2 - text.length);
    const name = node.kind === 'module' ? pc.bold(paint(text)) : paint(text);
    const loc = pc.dim(`${String(node.loc).padStart(locWidth)} LOC`);
    const score = paint(formatScore(node.state.R).padStart(4));
    // Leaves with usable questions show their count (M2_DESIGN.md §9); counts only, never content.
    const questions = node.isLeaf && node.okQuestions > 0 ? pc.dim(` · ${node.okQuestions} q`) : '';
    return `${pc.dim(prefix)}${paint('●')} ${name}${pad}  ${loc}  ${score}${questions}`;
  });

  const leaves = rows.filter((r) => r.node.isLeaf);
  const count = (c: ChunkColor) => leaves.filter((r) => r.node.state.color === c).length;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  lines.push(
    '',
    [
      `${pc.green('●')} green ≥${pct(cfg.greenAt)} (${count('green')})`,
      `${pc.yellow('●')} yellow ≥${pct(cfg.yellowAt)} (${count('yellow')})`,
      `${pc.red('●')} red (${count('red')})`,
      `${pc.gray('●')} grey: no questions (${count('grey')})`,
    ].join('  '),
  );
  return `${lines.join('\n')}\n`;
}
