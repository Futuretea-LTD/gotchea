// Per-user reconcile on read (M3_DESIGN.md §6.3). Progress is only reconciled with
// chunks.json by `scanRepo`; after a `git pull` every other command would show stale
// progress. `ensureReconciled` brings it up to date, under the repo lock, and costs one JSON
// read when nothing changed.
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { SourceReader } from '../generate/source.js';
import type { Chunk } from '../model/chunk.js';
import type { ProgressFile } from '../model/progress.js';
import { type ReconcileChange, reconcileProgress, reconcileSnapshotHashes } from '../scan/reconcile.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { FsProgressStore } from '../store/progress-store.js';
import { withRepoLock } from '../store/repo-lock.js';
import { computeRepoId } from '../store/repo-id.js';
import { FsSnapshotStore } from '../store/snapshot-store.js';

export interface EnsureReconciledOptions {
  config?: GotcheaConfig;
  env?: NodeJS.ProcessEnv;
  repoId?: string;
}

export interface ReconcileOutcome {
  changes: ReconcileChange[];
  /** Leaves whose working tree differs from chunks.json: left for the next scan. */
  deferred: string[];
}

type Pending = Pick<Chunk, 'id' | 'contentHash' | 'aliases' | 'ranges' | 'isLeaf'>;

/** Leaves whose progress sits under an alias or was last seen at another hash. */
function pendingLeaves(chunks: readonly Pending[], progress: ProgressFile): Pending[] {
  return chunks.filter((c) => {
    if (!c.isLeaf) return false;
    const p = progress.chunks[c.id];
    if (p) return p.lastSeenHash !== c.contentHash;
    return c.aliases?.some((a) => progress.chunks[a] !== undefined) ?? false;
  });
}

export async function ensureReconciled(root: string, opts: EnsureReconciledOptions = {}): Promise<ReconcileOutcome> {
  const none: ReconcileOutcome = { changes: [], deferred: [] };
  const file = await new FsChunkStore(root).load();
  if (!file) return none;
  const env = opts.env ?? process.env;
  const repoId = opts.repoId ?? (await computeRepoId(root));
  const progressStore = new FsProgressStore(repoId, env);
  if (pendingLeaves(file.chunks, await progressStore.load()).length === 0) return none;

  const config = opts.config ?? (await loadConfig(root));
  const reader = new SourceReader(root, config);
  const snapshots = new FsSnapshotStore(repoId, env);
  const fingerprints = new Map<string, string[]>();
  const deferred = new Set<string>();

  return withRepoLock(
    repoId,
    async () => {
      // Reload both: a scan may have run while this call waited for the lock.
      const fresh = (await new FsChunkStore(root).load()) ?? file;
      const progress = await progressStore.load();
      const todo = pendingLeaves(fresh.chunks, progress);
      if (todo.length === 0) return none;
      for (const c of todo) {
        // Parsing runs inside the lock only on this rare path; a mismatch means the tree moved on.
        const fp = fingerprints.has(c.id) ? fingerprints.get(c.id)! : await reader.fingerprints(c);
        if (fp === null || (await reader.currentHash(c)) !== c.contentHash) deferred.add(c.id);
        else fingerprints.set(c.id, fp);
      }
      const ready = todo.filter((c) => !deferred.has(c.id));
      const oldFingerprints = new Map<string, string[]>();
      for (const h of reconcileSnapshotHashes(ready, progress)) {
        const fp = await snapshots.get(h);
        if (fp) oldFingerprints.set(h, fp);
      }
      const result = reconcileProgress({ chunks: ready, progress, oldFingerprints, newFingerprints: fingerprints, cfg: config.score });
      for (const c of ready) {
        const fp = fingerprints.get(c.id);
        if (fp) await snapshots.put(c.contentHash, fp);
      }
      await progressStore.save(result.progress);
      return { changes: result.changes, deferred: [...deferred].sort() };
    },
    { env, label: 'reconcile' },
  );
}
