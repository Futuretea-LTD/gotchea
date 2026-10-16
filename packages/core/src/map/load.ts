import { now as currentTime } from '../now.js';
// Loads everything the map needs from disk and builds the tree.
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { ensureReconciled } from '../ops/reconcile.js';
import { computeTreeStates } from '../score/aggregate.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { FsProgressStore } from '../store/progress-store.js';
import { computeRepoId } from '../store/repo-id.js';
import { okQuestionCounts } from './question-counts.js';
import { buildMapTree, type MapNode } from './tree.js';

export interface LoadMapOptions {
  config?: GotcheaConfig;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Reconcile progress with chunks.json first (default true). */
  reconcile?: boolean;
}

export interface MapSnapshot {
  repoId: string;
  /** Null when chunks.json has no root chunk. */
  root: MapNode | null;
}

/** The full map tree, or null when the repo has not been scanned yet (no chunks.json). */
export async function loadMapTree(repoRoot: string, opts: LoadMapOptions = {}): Promise<MapSnapshot | null> {
  const config = opts.config ?? (await loadConfig(repoRoot));
  const file = await new FsChunkStore(repoRoot).load();
  if (!file) return null;
  const repoId = await computeRepoId(repoRoot);
  if (opts.reconcile !== false) await ensureReconciled(repoRoot, { config, repoId, ...(opts.env ? { env: opts.env } : {}) });
  const progress = await new FsProgressStore(repoId, opts.env ?? process.env).load();
  const okQuestions = await okQuestionCounts(repoRoot, file.chunks);
  const states = computeTreeStates({
    chunks: file.chunks,
    okQuestions,
    progress: progress.chunks,
    now: opts.now ?? currentTime(opts.env),
    cfg: config.score,
  });
  return { repoId, root: buildMapTree(file.chunks, states, okQuestions) };
}
