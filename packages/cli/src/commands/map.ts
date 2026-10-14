// `gotchea map [path] [--json]`: the comprehension heat map. Read-only.
import { basename } from 'node:path';
import { loadConfig, loadMapTree, mapJsonFrom } from 'gotchea-core';
import { CliError, requireRepoRoot, type CommandContext } from '../context.js';
import { toJson } from '../render/json.js';
import { renderHeatmap } from '../render/tree-heatmap.js';
import { toFilter } from '../target.js';

export interface MapOptions {
  json?: boolean;
}

export async function mapCommand(ctx: CommandContext, pathArg: string | undefined, opts: MapOptions): Promise<void> {
  const root = await requireRepoRoot(ctx.dir);
  const config = await loadConfig(root);
  const now = ctx.io.now();
  const snapshot = await loadMapTree(root, { config, env: ctx.io.env, now });
  if (!snapshot) throw new CliError('no scan yet: .gotchea/chunks.json is missing.\nRun `gotchea scan` first.');
  const filter = pathArg === undefined ? null : await toFilter(pathArg, ctx.dir, root);
  // chunks.json titles the root '.' (checkout-independent); show the repository directory name instead.
  const result = mapJsonFrom(snapshot, { rootTitle: basename(root), filter, generatedAt: now });
  if (result.status === 'no_root') throw new CliError('.gotchea/chunks.json has no root chunk.\nRun `gotchea scan` to rebuild it.');
  if (result.status === 'no_match') throw new CliError(`no chunks match ${result.filter}`);

  if (opts.json) ctx.io.stdout(toJson(result.json));
  else ctx.io.stdout(renderHeatmap(result.json.root, ctx.pc, config.score));
}
