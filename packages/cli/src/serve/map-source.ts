// The data behind `gotchea serve`: map snapshot and status, cached in memory and reloaded
// when the files they come from change (PLAN §7: one `fs.stat` per file per request, never
// a parse on the hot path). Read-only after startup: only `open` may write (reconcile).
import { stat } from 'node:fs/promises';
import {
  computeRepoId,
  ensureReconciled,
  getStatus,
  loadConfig,
  loadMapTree,
  repoPaths,
  userPaths,
  type GotcheaConfig,
  type MapSnapshot,
  type StatusReport,
} from 'gotchea-core';

/**
 * R and the colors decay with time even when no file changes, so a cache older than this
 * is recomputed. Also covers in-place edits of a question file (no rename, so the
 * questions/ directory mtime stays put).
 */
export const MAX_CACHE_AGE_MS = 60_000;

export interface MapData {
  /** When this data was computed; the documents' `generatedAt`, stable until the next reload. */
  generatedAt: Date;
  /** Null when the repo has not been scanned (no chunks.json). */
  snapshot: MapSnapshot | null;
  status: StatusReport;
}

export interface MapSourceOptions {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  config?: GotcheaConfig;
}

interface Watched {
  chunks: string;
  config: string;
  questionsDir: string;
  progress: string;
}

export class MapSource {
  #config: GotcheaConfig;
  #configPrint: string;
  #cache: { print: string; data: MapData } | null = null;
  #pending: Promise<MapData> | null = null;

  private constructor(
    readonly root: string,
    private readonly opts: MapSourceOptions,
    private readonly watched: Watched,
    config: GotcheaConfig,
    configPrint: string,
  ) {
    this.#config = config;
    this.#configPrint = configPrint;
  }

  /** Reconciles progress once (the only write, under the repo lock), then serves reads only. */
  static async open(root: string, opts: MapSourceOptions): Promise<MapSource> {
    const paths = repoPaths(root);
    const configPrint = await fingerprint(paths.config);
    const config = opts.config ?? (await loadConfig(root));
    const repoId = await computeRepoId(root);
    await ensureReconciled(root, { config, env: opts.env, repoId });
    const watched = { chunks: paths.chunks, config: paths.config, questionsDir: paths.questionsDir, progress: userPaths(repoId, opts.env).progress };
    return new MapSource(root, opts, watched, config, configPrint);
  }

  /** The cached data, recomputed when a watched file changed or the cache expired. */
  async get(): Promise<MapData> {
    // Concurrent requests share one reload.
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(): Promise<MapData> {
    const w = this.watched;
    const [chunks, config, questions, progress] = await Promise.all([
      fingerprint(w.chunks),
      fingerprint(w.config),
      fingerprint(w.questionsDir),
      fingerprint(w.progress),
    ]);
    const print = `${chunks}|${config}|${questions}|${progress}`;
    const now = this.opts.now();
    const cache = this.#cache;
    if (cache && cache.print === print && now.getTime() - cache.data.generatedAt.getTime() < MAX_CACHE_AGE_MS) return cache.data;

    if (config !== this.#configPrint) {
      this.#config = await loadConfig(this.root);
      this.#configPrint = config;
    }
    const opts = { config: this.#config, env: this.opts.env, now, reconcile: false };
    const [snapshot, status] = await Promise.all([loadMapTree(this.root, opts), getStatus(this.root, opts)]);
    const data: MapData = { generatedAt: now, snapshot, status };
    this.#cache = { print, data };
    return data;
  }
}

/** mtime, size and inode of `path` (atomic writes rename, so the inode moves too), or "missing". */
async function fingerprint(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'missing';
  }
}
