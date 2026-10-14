// Scan diff against the previous chunks.json (PLAN.md §5 steps 3, 4). Pure.
import { compareCodeUnits } from '../hash/hash.js';
import { NORMALIZATION_VERSION } from '../hash/normalize.js';
import { MAX_ALIASES, type Chunk, type ChunkKind, type ChunksFile } from '../model/chunk.js';
import { changeRatio } from './line-diff.js';

export interface ChunkChange {
  id: string;
  kind: ChunkKind;
  oldHash: string;
  newHash: string;
  /** changed normalized lines / old LOC, in [0, 1]; 1 when the old snapshot is unknown. */
  changeRatio: number;
}

export interface ChunkMove {
  from: string;
  to: string;
  kind: ChunkKind;
  contentHash: string;
}

export interface ScanDiff {
  /** Ids sorted by code units in every list. */
  added: string[];
  removed: string[];
  unchanged: string[];
  changed: ChunkChange[];
  /** Removed × added pairs with the same kind and contentHash. */
  moved: ChunkMove[];
  /** Same id, hash differs only because the normalization version changed: no decay. */
  renormalized: ChunkChange[];
}

export interface DiffFingerprints {
  /** Line fingerprints of old content, by old contentHash (from the SnapshotStore). */
  old: ReadonlyMap<string, readonly string[]>;
  /** Line fingerprints of new content, by chunk id. */
  new: ReadonlyMap<string, readonly string[]>;
}

const EMPTY: DiffFingerprints = { old: new Map(), new: new Map() };

export function computeScanDiff(prev: ChunksFile | null, next: readonly Chunk[], fp: DiffFingerprints = EMPTY): ScanDiff {
  const prevById = new Map((prev?.chunks ?? []).map((c) => [c.id, c]));
  const nextById = new Map(next.map((c) => [c.id, c]));
  const renormalizing = prev !== null && prev.normalization !== NORMALIZATION_VERSION;

  const diff: ScanDiff = { added: [], removed: [], unchanged: [], changed: [], moved: [], renormalized: [] };
  for (const c of next) {
    const old = prevById.get(c.id);
    if (!old) {
      diff.added.push(c.id);
    } else if (old.contentHash === c.contentHash) {
      diff.unchanged.push(c.id);
    } else {
      const change: ChunkChange = {
        id: c.id,
        kind: c.kind,
        oldHash: old.contentHash,
        newHash: c.contentHash,
        changeRatio: renormalizing ? 0 : changeRatio(fp.old.get(old.contentHash) ?? null, fp.new.get(c.id) ?? []),
      };
      (renormalizing ? diff.renormalized : diff.changed).push(change);
    }
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) diff.removed.push(id);

  // Move detection: pair each removed chunk with an unclaimed added chunk of the same kind + hash,
  // preferring the same symbol path, then the same file name. Empty chunks (LOC 0) all share one
  // hash and carry nothing worth moving, so they are never paired.
  diff.added.sort(compareCodeUnits);
  diff.removed.sort(compareCodeUnits);
  const addedByKey = new Map<string, string[]>();
  for (const id of diff.added) {
    const c = nextById.get(id)!;
    if (c.metrics.loc === 0) continue;
    const key = `${c.kind}:${c.contentHash}`;
    const list = addedByKey.get(key);
    if (list) list.push(id);
    else addedByKey.set(key, [id]);
  }
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  // Strictest preference first across all removed chunks, so an earlier loose match cannot steal
  // the target a later chunk matches exactly.
  const preferences: ((from: string, to: string) => boolean)[] = [
    (from, to) => symbolSuffix(to) === symbolSuffix(from) && fileName(to) === fileName(from),
    (from, to) => symbolSuffix(to) === symbolSuffix(from),
    () => true,
  ];
  for (const prefer of preferences) {
    for (const id of diff.removed) {
      if (movedFrom.has(id)) continue;
      const c = prevById.get(id)!;
      const candidates = addedByKey.get(`${c.kind}:${c.contentHash}`) ?? [];
      const i = candidates.findIndex((to) => prefer(id, to));
      if (i < 0) continue;
      const to = candidates.splice(i, 1)[0]!;
      diff.moved.push({ from: id, to, kind: c.kind, contentHash: c.contentHash });
      movedFrom.add(id);
      movedTo.add(to);
    }
  }
  diff.moved.sort((x, y) => compareCodeUnits(x.from, y.from));
  diff.added = diff.added.filter((id) => !movedTo.has(id));
  diff.removed = diff.removed.filter((id) => !movedFrom.has(id));
  diff.unchanged.sort(compareCodeUnits);
  diff.changed.sort((a, b) => compareCodeUnits(a.id, b.id));
  diff.renormalized.sort((a, b) => compareCodeUnits(a.id, b.id));
  return diff;
}

/** `#Outer.inner` part of an id ('' for files and modules). */
function symbolSuffix(id: string): string {
  const hash = id.indexOf('#');
  return hash < 0 ? '' : id.slice(hash);
}

function fileName(id: string): string {
  const path = id.split('#')[0]!;
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Carries `aliases` forward: an unchanged id keeps its previous aliases, a
 * moved chunk gets its old id prepended. Capped at MAX_ALIASES, newest first.
 */
export function carryAliases(prev: ChunksFile | null, next: readonly Chunk[], moved: readonly ChunkMove[]): Chunk[] {
  const prevById = new Map((prev?.chunks ?? []).map((c) => [c.id, c]));
  const fromByTo = new Map(moved.map((m) => [m.to, m.from]));
  return next.map((c) => {
    const from = fromByTo.get(c.id);
    const inherited = from !== undefined ? [from, ...(prevById.get(from)?.aliases ?? [])] : (prevById.get(c.id)?.aliases ?? []);
    const aliases = [...new Set(inherited)].filter((a) => a !== c.id).slice(0, MAX_ALIASES);
    const { aliases: _drop, ...rest } = c;
    return aliases.length > 0 ? { ...rest, aliases } : rest;
  });
}
