// Applying a scan diff to question pools and progress (PLAN.md §5 steps 4-6),
// and the per-user reconcile (§5 "Per-user reconcile"). Pure: callers load
// inputs from the stores and persist the results.
import type { ScoreConfig } from '../config/schema.js';
import type { Chunk } from '../model/chunk.js';
import type { Progress, ProgressFile } from '../model/progress.js';
import type { QuestionPrivate } from '../model/question.js';
import { onContentChange } from '../score/transitions.js';
import type { ScanDiff } from './diff.js';
import { changeRatio } from './line-diff.js';

export interface ApplyDiffInput {
  diff: ScanDiff;
  /** Current pools for every chunk id the diff touches (changed, renormalized, moved.from/to, removed). */
  questions: ReadonlyMap<string, readonly QuestionPrivate[]>;
  progress: ProgressFile;
  cfg: ScoreConfig;
}

export interface ApplyDiffResult {
  /** Pools to write back; an empty array means delete the pool. Untouched pools are absent. */
  questions: Map<string, QuestionPrivate[]>;
  progress: ProgressFile;
  /** Questions newly marked stale. */
  staleCount: number;
  /** Progress entries decayed by `changeRatio` (the user last saw exactly the old hash). */
  decayed: ReconcileChange[];
}

/**
 * Moves pools and progress along detected moves, marks `ok` questions of
 * changed chunks stale, decays progress by `changeRatio` when the user last saw
 * exactly the old hash, rewrites hashes for renormalized chunks and deletes the
 * pools of removed chunks. Progress of removed chunks is kept (future `gc`).
 */
export function applyScanDiff(input: ApplyDiffInput): ApplyDiffResult {
  const { diff, cfg } = input;
  const pools = new Map<string, QuestionPrivate[]>();
  const pool = (id: string): QuestionPrivate[] => pools.get(id) ?? (input.questions.get(id) ?? []).map((q) => ({ ...q }));
  const chunks: Record<string, Progress> = { ...input.progress.chunks };
  let staleCount = 0;
  const decayed: ReconcileChange[] = [];

  for (const m of diff.moved) {
    const moving = pool(m.from).map((q) => ({ ...q, chunkId: m.to }));
    const existing = pool(m.to);
    const ids = new Set(existing.map((q) => q.id));
    pools.set(m.to, [...existing, ...moving.filter((q) => !ids.has(q.id))]);
    pools.set(m.from, []);
    const p = chunks[m.from];
    if (p && !chunks[m.to]) chunks[m.to] = p;
    delete chunks[m.from];
  }

  for (const c of diff.changed) {
    const qs = pool(c.id).map((q) => {
      if (q.status !== 'ok' || q.chunkHash === c.newHash) return q;
      staleCount++;
      return { ...q, status: 'stale' as const };
    });
    if (qs.length > 0) pools.set(c.id, qs);
    const p = chunks[c.id];
    if (p && p.lastSeenHash === c.oldHash) {
      chunks[c.id] = onContentChange(p, c.changeRatio, c.newHash, cfg);
      decayed.push({ id: c.id, fromHash: c.oldHash, toHash: c.newHash, changeRatio: c.changeRatio });
    }
  }

  for (const c of diff.renormalized) {
    const qs = pool(c.id).map((q) => (q.chunkHash === c.oldHash ? { ...q, chunkHash: c.newHash } : q));
    if (qs.length > 0) pools.set(c.id, qs);
    const p = chunks[c.id];
    if (p && p.lastSeenHash === c.oldHash) {
      chunks[c.id] = { ...p, lastSeenHash: c.newHash, lastPassedHash: p.lastPassedHash === c.oldHash ? c.newHash : p.lastPassedHash };
    }
  }

  for (const id of diff.removed) pools.set(id, []);

  return { questions: pools, progress: { ...input.progress, chunks }, staleCount, decayed };
}

export interface ReconcileInput {
  chunks: readonly Pick<Chunk, 'id' | 'contentHash' | 'isLeaf' | 'aliases'>[];
  progress: ProgressFile;
  /** Old line fingerprints by content hash (SnapshotStore). */
  oldFingerprints: ReadonlyMap<string, readonly string[]>;
  /** Current line fingerprints by chunk id. */
  newFingerprints: ReadonlyMap<string, readonly string[]>;
  cfg: ScoreConfig;
}

export interface ReconcileChange {
  id: string;
  fromHash: string;
  toHash: string;
  changeRatio: number;
}

/**
 * Brings personal progress up to date with chunks.json (e.g. after a pull):
 * entries stored under an alias move to the current id, and every entry whose
 * `lastSeenHash` differs from the chunk's hash decays via `onContentChange`.
 */
export function reconcileProgress(input: ReconcileInput): { progress: ProgressFile; changes: ReconcileChange[] } {
  const chunks: Record<string, Progress> = { ...input.progress.chunks };
  const changes: ReconcileChange[] = [];
  for (const c of input.chunks) {
    if (!chunks[c.id]) {
      const alias = c.aliases?.find((a) => chunks[a]);
      if (alias !== undefined) {
        chunks[c.id] = chunks[alias]!;
        delete chunks[alias];
      }
    }
    const p = chunks[c.id];
    if (!p || p.lastSeenHash === c.contentHash) continue;
    const ratio = changeRatio(input.oldFingerprints.get(p.lastSeenHash) ?? null, input.newFingerprints.get(c.id) ?? []);
    chunks[c.id] = onContentChange(p, ratio, c.contentHash, input.cfg);
    changes.push({ id: c.id, fromHash: p.lastSeenHash, toHash: c.contentHash, changeRatio: ratio });
  }
  return { progress: { ...input.progress, chunks }, changes };
}

/** Old content hashes `reconcileProgress` will need snapshots for. */
export function reconcileSnapshotHashes(
  chunks: readonly Pick<Chunk, 'id' | 'contentHash' | 'aliases'>[],
  progress: ProgressFile,
): string[] {
  const out = new Set<string>();
  for (const c of chunks) {
    const p = progress.chunks[c.id] ?? c.aliases?.map((a) => progress.chunks[a]).find(Boolean);
    if (p && p.lastSeenHash !== c.contentHash) out.add(p.lastSeenHash);
  }
  return [...out].sort();
}
