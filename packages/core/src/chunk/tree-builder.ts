// TreeBuilder (PLAN.md §3): turns per-file drafts into the final chunk list.
// Adds module chunks from directories and assigns ids, hashes, metrics and
// question counts. Generic: knows nothing about code beyond the draft shape.
import type { GotcheaConfig } from '../config/schema.js';
import { compareCodeUnits, contentHash, moduleHash } from '../hash/hash.js';
import type { Chunk } from '../model/chunk.js';
import { ROOT_MODULE_ID, parentDir, symbolChunkId, toPosixPath } from '../model/ids.js';
import { questionCount } from '../score/state.js';
import type { ChunkDraft, FileDraft } from './chunker.js';
import type { FanInIndex } from './fanin.js';
import { draftSymbolPaths } from './grouping.js';

export interface BuiltFile {
  path: string;
  /** Chunker id, e.g. 'code'. */
  source: string;
  draft: FileDraft;
}

export interface BuiltTree {
  /** Sorted by id. */
  chunks: Chunk[];
  /** Normalized lines per non-module chunk id (for snapshots and changeRatio). */
  lines: Map<string, string[]>;
}

export interface BuildTreeOptions {
  /** Title for the root module; defaults to '.'. */
  rootTitle?: string;
  fanIn?: FanInIndex;
}

/** Module chunks report their children's chunker id, or 'mixed' when several chunkers contributed. */
export const MIXED_SOURCE = 'mixed';

export function buildTree(inputFiles: readonly BuiltFile[], cfg: Pick<GotcheaConfig, 'questions'>, opts: BuildTreeOptions = {}): BuiltTree {
  // Ids are POSIX + NFC whatever the caller passes (e.g. win32 `src\\a.ts`).
  const files = inputFiles.map((f) => ({ ...f, path: toPosixPath(f.path) }));
  const chunks: Chunk[] = [];
  const seenIds = new Set<string>();
  const lines = new Map<string, string[]>();
  const moduleChildren = new Map<string, Chunk[]>();
  const addToModule = (dir: string, c: Chunk) => {
    const list = moduleChildren.get(dir);
    if (list) list.push(c);
    else moduleChildren.set(dir, [c]);
  };

  for (const f of files) {
    const lang = f.draft.lang;
    const visit = (d: ChunkDraft, parentId: string): Chunk => {
      const id = symbolChunkId(f.path, d.symbolPath);
      if (seenIds.has(id)) throw new Error(`Duplicate chunk id: ${id}`);
      seenIds.add(id);
      const isLeaf = d.children.length === 0;
      const fanIn = !opts.fanIn ? 0 : d.kind === 'file' ? opts.fanIn.file(f.path) : opts.fanIn.symbol(f.path, draftSymbolPaths(d));
      const metrics = { loc: d.normalizedLines.length, complexity: d.complexity, fanIn };
      const chunk: Chunk = {
        id,
        kind: d.kind,
        parentId,
        title: d.title,
        source: f.source,
        ...(lang === undefined ? {} : { lang }),
        ranges: d.ranges.map((r) => ({ ...r, path: toPosixPath(r.path) })),
        contentHash: contentHash(d.normalizedLines),
        metrics,
        questionCount: isLeaf ? questionCount(metrics, cfg.questions) : 0,
        isLeaf,
      };
      chunks.push(chunk);
      lines.set(id, d.normalizedLines);
      for (const child of d.children) visit(child, id);
      return chunk;
    };
    addToModule(parentDir(f.path), visit(f.draft, parentDir(f.path)));
  }

  // Every ancestor directory of a file becomes a module, up to the root `.`.
  const dirs = new Set<string>([ROOT_MODULE_ID]);
  for (const f of files) {
    for (let d = parentDir(f.path); d !== ROOT_MODULE_ID; d = parentDir(d)) dirs.add(d);
  }
  // Deepest first so child module hashes exist before their parents need them.
  const ordered = [...dirs].sort((a, b) => depth(b) - depth(a) || compareCodeUnits(a, b));
  for (const dir of ordered) {
    const children = moduleChildren.get(dir) ?? [];
    const isRoot = dir === ROOT_MODULE_ID;
    const module: Chunk = {
      id: dir,
      kind: 'module',
      parentId: isRoot ? null : parentDir(dir),
      title: isRoot ? (opts.rootTitle ?? ROOT_MODULE_ID) : dir.slice(dir.lastIndexOf('/') + 1),
      source: moduleSource(children),
      ranges: [],
      contentHash: moduleHash(children),
      metrics: {
        loc: children.reduce((s, c) => s + c.metrics.loc, 0),
        complexity: children.reduce((s, c) => s + c.metrics.complexity, 0),
        fanIn: opts.fanIn ? opts.fanIn.module(dir) : 0,
      },
      questionCount: 0,
      isLeaf: false,
    };
    chunks.push(module);
    if (!isRoot) addToModule(parentDir(dir), module);
  }

  chunks.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { chunks, lines };
}

function moduleSource(children: readonly Chunk[]): string {
  const sources = new Set(children.map((c) => c.source));
  return sources.size === 1 ? [...sources][0]! : MIXED_SOURCE;
}

function depth(dir: string): number {
  return dir === ROOT_MODULE_ID ? 0 : dir.split('/').length;
}
