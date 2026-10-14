// Repo-level progress numbers shared by the CLI and the MCP server.
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import type { ChunkColor } from '../model/progress.js';
import { okQuestionCounts } from '../map/question-counts.js';
import { computeTreeStates } from '../score/aggregate.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { ensureReconciled } from './reconcile.js';
import { FsProgressStore } from '../store/progress-store.js';
import { computeRepoId } from '../store/repo-id.js';

export interface StatusReport {
  /** False until the first scan wrote chunks.json; all numbers are then 0. */
  scanned: boolean;
  /** Tracked chunks of every kind. */
  chunks: number;
  leaves: number;
  /** Usable questions (`ok`, not flagged, current hash) across all chunks. */
  questions: number;
  /** Leaves whose review is due now. */
  due: number;
  /** Leaf count per color (`grey` = no questions yet). */
  colors: Record<ChunkColor, number>;
}

export interface GetStatusOptions {
  config?: GotcheaConfig;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Reconcile progress with chunks.json first (default true). */
  reconcile?: boolean;
}

export async function getStatus(repoRoot: string, opts: GetStatusOptions = {}): Promise<StatusReport> {
  const colors: Record<ChunkColor, number> = { grey: 0, red: 0, yellow: 0, green: 0 };
  const file = await new FsChunkStore(repoRoot).load();
  if (!file) return { scanned: false, chunks: 0, leaves: 0, questions: 0, due: 0, colors };

  const config = opts.config ?? (await loadConfig(repoRoot));
  const now = opts.now ?? new Date();
  const repoId = await computeRepoId(repoRoot);
  if (opts.reconcile !== false) await ensureReconciled(repoRoot, { config, repoId, ...(opts.env ? { env: opts.env } : {}) });
  const progress = await new FsProgressStore(repoId, opts.env ?? process.env).load();
  const okQuestions = await okQuestionCounts(repoRoot, file.chunks);
  const states = computeTreeStates({ chunks: file.chunks, okQuestions, progress: progress.chunks, now, cfg: config.score });

  let leaves = 0;
  let due = 0;
  for (const c of file.chunks) {
    if (!c.isLeaf) continue;
    leaves++;
    const state = states.get(c.id);
    colors[state?.color ?? 'grey']++;
    if (state?.dueAt !== undefined && Date.parse(state.dueAt) <= now.getTime()) due++;
  }
  let questions = 0;
  for (const n of okQuestions.values()) questions += n;
  return { scanned: true, chunks: file.chunks.length, leaves, questions, due, colors };
}
