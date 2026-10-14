// `gotchea scan`: chunk + hash + fanIn, diff against the previous chunks.json,
// mark stale questions and decay progress (all inside core's scanRepo).
import { performance } from 'node:perf_hooks';
import { GOTCHEA_DIR, loadConfig, runScan, type ScanResult, type SkipReason } from 'gotchea-core';
import { requireRepoRoot, type CommandContext } from '../context.js';
import { toJson } from '../render/json.js';

/** Changed leaves listed individually; the rest is summarized. */
const MAX_LISTED = 20;

const SKIP_LABELS: Partial<Record<SkipReason, string>> = {
  always: 'always-excluded',
  'not-included': 'not included',
  'too-large': 'too large',
  'outside-root': 'symlinked outside the repo',
};

export interface ScanOptions {
  json?: boolean;
}

export async function scanCommand(ctx: CommandContext, opts: ScanOptions = {}): Promise<void> {
  const root = await requireRepoRoot(ctx.dir);
  const config = await loadConfig(root);
  const started = performance.now();
  const { summary, result } = await runScan(root, { config, env: ctx.io.env });
  if (opts.json) {
    // stdout carries only the JSON; parse warnings still go to stderr.
    ctx.io.stdout(toJson(summary));
    for (const path of result.parseFailures) ctx.warn(`could not parse ${path}; chunked as a single leaf`);
    return;
  }
  printSummary(ctx, result, Math.round(performance.now() - started));
}

function printSummary(ctx: CommandContext, r: ScanResult, ms: number): void {
  const { pc, out, warn } = ctx;
  const { diff } = r;

  // gotchea's own state directory is not a "skipped" source file.
  const skippedFiles = r.skipped.filter((s) => s.path !== `${GOTCHEA_DIR}/` && !s.path.startsWith(`${GOTCHEA_DIR}/`));
  const reasons = new Map<string, number>();
  for (const s of skippedFiles) {
    const label = SKIP_LABELS[s.reason] ?? s.reason;
    reasons.set(label, (reasons.get(label) ?? 0) + 1);
  }
  const skipped =
    skippedFiles.length === 0
      ? 'none skipped'
      : `${skippedFiles.length} skipped: ${[...reasons].map(([reason, n]) => `${n} ${reason}`).join(', ')}`;
  out(`Scanned ${r.files.length} ${plural(r.files.length, 'file')} in ${ms} ms (${skipped})`);
  const leaves = r.chunks.filter((c) => c.isLeaf).length;
  out(`${r.chunks.length} ${plural(r.chunks.length, 'chunk')}, ${leaves} ${leaves === 1 ? 'leaf' : 'leaves'}`);
  out();

  const rows: [string, number, (s: string) => string][] = [
    ['added', diff.added.length, pc.green],
    ['changed', diff.changed.length, pc.yellow],
    ['removed', diff.removed.length, pc.red],
    ['unchanged', diff.unchanged.length, pc.dim],
  ];
  if (diff.moved.length > 0) rows.push(['moved', diff.moved.length, pc.cyan]);
  if (diff.renormalized.length > 0) rows.push(['renormalized', diff.renormalized.length, pc.cyan]);
  const width = Math.max(...rows.map(([, n]) => String(n).length));
  for (const [label, n, paint] of rows) out(`  ${paint(String(n).padStart(width))} ${label}`);

  // Leaves carry questions and progress, so their changeRatio is the one that matters.
  const leafIds = new Set(r.chunks.filter((c) => c.isLeaf).map((c) => c.id));
  const changedLeaves = diff.changed.filter((c) => leafIds.has(c.id)).sort((a, b) => b.changeRatio - a.changeRatio);
  if (changedLeaves.length > 0) {
    out();
    out('Changed leaves (changeRatio):');
    const idWidth = Math.min(60, Math.max(...changedLeaves.slice(0, MAX_LISTED).map((c) => c.id.length)));
    for (const c of changedLeaves.slice(0, MAX_LISTED)) {
      const pct = `${Math.round(c.changeRatio * 100)}%`.padStart(4);
      out(`  ${c.id.padEnd(idWidth)}  ${c.changeRatio > 0.5 ? pc.red(pct) : pc.yellow(pct)}`);
    }
    if (changedLeaves.length > MAX_LISTED) out(pc.dim(`  … and ${changedLeaves.length - MAX_LISTED} more`));
  }
  for (const m of diff.moved) out(pc.dim(`  moved ${m.from} → ${m.to}`));

  const decayed = r.decayed.length + r.reconciled.length;
  if (r.staleQuestions > 0 || decayed > 0) {
    out();
    if (r.staleQuestions > 0) out(`${r.staleQuestions} ${plural(r.staleQuestions, 'question')} marked stale`);
    if (decayed > 0) out(`Progress decayed for ${decayed} ${plural(decayed, 'chunk')}`);
  }
  for (const path of r.parseFailures) warn(`could not parse ${path}; chunked as a single leaf`);
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
