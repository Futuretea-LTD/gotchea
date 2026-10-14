// Scan orchestration (PLAN.md §5): walk → chunk → tree + fanIn → diff against
// the previous chunks.json → apply to questions/progress → persist. All
// decisions live in the pure modules; this file only does I/O and wiring.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Chunker, FileDraft } from '../chunk/chunker.js';
import { CodeChunker } from '../chunk/code-chunker.js';
import { buildFanIn, type FileReferences } from '../chunk/fanin.js';
import { buildTree, type BuiltFile } from '../chunk/tree-builder.js';
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { walkFiles, type SkippedFile } from '../fs/walker.js';
import { lineFingerprints } from '../hash/hash.js';
import { NORMALIZATION_VERSION } from '../hash/normalize.js';
import type { Chunk, ChunksFile } from '../model/chunk.js';
import type { ProgressFile } from '../model/progress.js';
import type { QuestionPrivate } from '../model/question.js';
import { createDefaultRegistry } from '../parse/registry.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { FsProgressStore } from '../store/progress-store.js';
import { FsQuestionStore } from '../store/question-store.js';
import { computeRepoId } from '../store/repo-id.js';
import { withRepoLock } from '../store/repo-lock.js';
import { FsSnapshotStore } from '../store/snapshot-store.js';
import type { ChunkStore, ProgressStore, QuestionStore, SnapshotStore } from '../store/types.js';
import { carryAliases, computeScanDiff, type ScanDiff } from './diff.js';
import { applyScanDiff, reconcileProgress, reconcileSnapshotHashes, type ReconcileChange } from './reconcile.js';

export interface ScanStores {
  chunks: ChunkStore;
  questions: QuestionStore;
  progress: ProgressStore;
  snapshots: SnapshotStore;
}

export interface ScanOptions {
  root: string;
  config?: GotcheaConfig;
  /** Defaults to [CodeChunker over the default parser registry]. */
  chunkers?: readonly Chunker[];
  /** Defaults to the Fs stores for `root` / `repoId`. */
  stores?: Partial<ScanStores>;
  repoId?: string;
  useGit?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Compute and report the diff without writing anything. */
  dryRun?: boolean;
}

export interface ScanResult {
  repoId: string;
  chunks: Chunk[];
  diff: ScanDiff;
  files: string[];
  skipped: SkippedFile[];
  /** Files chunked as a single leaf because parsing failed. */
  parseFailures: string[];
  staleQuestions: number;
  /** Progress entries decayed by the diff (changed chunks the user last saw at the old hash). */
  decayed: ReconcileChange[];
  /** Progress entries decayed by the per-user reconcile (beyond the diff itself). */
  reconciled: ReconcileChange[];
}

export async function scanRepo(opts: ScanOptions): Promise<ScanResult> {
  const { root } = opts;
  const config = opts.config ?? (await loadConfig(root));
  const repoId = opts.repoId ?? (await computeRepoId(root));
  const env = opts.env ?? process.env;
  const stores: ScanStores = {
    chunks: opts.stores?.chunks ?? new FsChunkStore(root),
    questions: opts.stores?.questions ?? new FsQuestionStore(root),
    progress: opts.stores?.progress ?? new FsProgressStore(repoId, env),
    snapshots: opts.stores?.snapshots ?? new FsSnapshotStore(repoId, env),
  };
  const chunkers = opts.chunkers ?? [new CodeChunker(createDefaultRegistry(config.languages))];
  const chunkerFor = (path: string) => chunkers.find((c) => c.supports(path));

  // 1. Files.
  const walk = await walkFiles(root, config, {
    ...(opts.useGit === undefined ? {} : { useGit: opts.useGit }),
    accept: (p) => chunkerFor(p) !== undefined,
  });

  // 2. Drafts and references, one file at a time.
  const built: BuiltFile[] = [];
  const refs: FileReferences[] = [];
  const parseFailures: string[] = [];
  const files: string[] = [];
  const skipped = [...walk.skipped];
  for (const path of walk.files) {
    const chunker = chunkerFor(path)!;
    let text: string;
    try {
      text = await readFile(join(root, path), 'utf8');
    } catch {
      // Deleted or made unreadable since the walk: skip it rather than abort the scan.
      skipped.push({ path, reason: 'unreadable' });
      continue;
    }
    files.push(path);
    const unit = { path, text };
    const draft: FileDraft = await chunker.chunk(unit, config.chunking);
    if (draft.parseFailed) parseFailures.push(path);
    built.push({ path, source: chunker.id, draft });
    if (chunker.references) {
      const r = await chunker.references(unit);
      refs.push({ path, lang: draft.lang ?? '', imports: r.imports, idents: new Set(r.idents) });
    }
  }

  // 3. Tree with metrics.
  const fanIn = buildFanIn(refs, new Set(files));
  // No rootTitle: chunks.json is shared, so it must not depend on the checkout directory name.
  const tree = buildTree(built, config, { fanIn });
  const fingerprints = new Map<string, string[]>();
  for (const [id, lines] of tree.lines) fingerprints.set(id, lineFingerprints(lines));

  // Steps 1-3 (walk, parse, tree) ran without the lock; 4-6 read-modify-write shared state.
  const apply = async (): Promise<ScanResult> => {
    // 4. Diff against the previous scan.
    const prev = await stores.chunks.load();
    const oldHashes = new Set<string>();
    const prevById = new Map((prev?.chunks ?? []).map((c) => [c.id, c]));
    for (const c of tree.chunks) {
      const old = prevById.get(c.id);
      if (old && old.contentHash !== c.contentHash) oldHashes.add(old.contentHash);
    }
    const diff = computeScanDiff(prev, tree.chunks, { old: await loadSnapshots(stores.snapshots, oldHashes), new: fingerprints });
    const chunks = carryAliases(prev, tree.chunks, diff.moved);

    // 5. Questions + progress.
    const touched = new Set<string>([
      ...diff.changed.map((c) => c.id),
      ...diff.renormalized.map((c) => c.id),
      ...diff.moved.flatMap((m) => [m.from, m.to]),
      ...diff.removed,
    ]);
    const pools = new Map<string, QuestionPrivate[]>();
    for (const id of touched) pools.set(id, await stores.questions.list(id));
    const progress: ProgressFile = await stores.progress.load();
    const applied = applyScanDiff({ diff, questions: pools, progress, cfg: config.score });
    const reconciled = reconcileProgress({
      chunks,
      progress: applied.progress,
      oldFingerprints: await loadSnapshots(stores.snapshots, reconcileSnapshotHashes(chunks, applied.progress)),
      newFingerprints: fingerprints,
      cfg: config.score,
    });

    const result: ScanResult = {
      repoId,
      chunks,
      diff,
      files,
      skipped,
      parseFailures,
      staleQuestions: applied.staleCount,
      decayed: applied.decayed,
      reconciled: reconciled.changes,
    };
    if (opts.dryRun) return result;

    // 6. Persist: snapshots first, chunks.json last, so a crash leaves the old scan in place.
    for (const c of chunks) {
      const fp = fingerprints.get(c.id);
      if (c.isLeaf && fp) await stores.snapshots.put(c.contentHash, fp);
    }
    for (const [id, qs] of applied.questions) {
      if (qs.length > 0) await stores.questions.save(id, qs);
      else await stores.questions.remove(id);
    }
    await stores.progress.save(reconciled.progress);
    const file: ChunksFile = { version: 1, normalization: NORMALIZATION_VERSION, chunks };
    await stores.chunks.save(file);
    return result;
  };
  return opts.dryRun ? apply() : withRepoLock(repoId, apply, { env, label: 'scan' });
}

async function loadSnapshots(store: SnapshotStore, hashes: Iterable<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const h of hashes) {
    const fp = await store.get(h);
    if (fp) out.set(h, fp);
  }
  return out;
}
