// `gotchea status [--json]`: repo-level numbers (chunks, questions, due, color distribution). Read-only.
import { getStatus, loadConfig, statusJsonFrom, type ChunkColor } from 'gotchea-core';
import { requireRepoRoot, type CommandContext } from '../context.js';
import { toJson } from '../render/json.js';

export interface StatusOptions {
  json?: boolean;
}

const COLORS: readonly ChunkColor[] = ['green', 'yellow', 'red', 'grey'];

export async function statusCommand(ctx: CommandContext, opts: StatusOptions = {}): Promise<void> {
  const { out, pc } = ctx;
  const root = await requireRepoRoot(ctx.dir);
  const config = await loadConfig(root);
  const now = ctx.io.now();
  const r = await getStatus(root, { config, env: ctx.io.env, now });
  if (opts.json) {
    ctx.io.stdout(toJson(statusJsonFrom(r, now)));
    return;
  }
  if (!r.scanned) {
    out('Nothing tracked yet. Run `gotchea scan` first.');
    return;
  }

  out(`${r.chunks} ${plural(r.chunks, 'chunk')} tracked, ${r.leaves} ${r.leaves === 1 ? 'leaf' : 'leaves'}`);
  out(`${r.questions} ${plural(r.questions, 'question')}`);
  out(`${r.due} due for review`);
  out();
  const paint: Record<ChunkColor, (s: string) => string> = { green: pc.green, yellow: pc.yellow, red: pc.red, grey: pc.dim };
  const width = Math.max(...COLORS.map((c) => String(r.colors[c]).length));
  for (const c of COLORS) out(`  ${paint[c](String(r.colors[c]).padStart(width))} ${c}`);
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
