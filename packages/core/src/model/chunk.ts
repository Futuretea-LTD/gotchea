// Chunk model (PLAN.md §3, §4). Chunks are content-agnostic: the code chunker
// is one producer, later chunkers (markdown, openapi) emit the same shape.

export type ChunkKind = 'module' | 'file' | 'group' | 'symbol';

/** 1-based, inclusive line range inside a repo-relative POSIX path. */
export interface LineRange {
  path: string;
  start: number;
  end: number;
}

export interface ChunkMetrics {
  /** Normalized SLOC: no blank lines, no comments. */
  loc: number;
  /** 1 + decision nodes. */
  complexity: number;
  /** Distinct importing files / referencing files. */
  fanIn: number;
}

export interface Chunk {
  id: string;
  kind: ChunkKind;
  parentId: string | null;
  /** Display name. */
  title: string;
  /** Chunker id: 'code' (later 'markdown', 'openapi'). */
  source: string;
  lang?: string;
  ranges: LineRange[];
  /** Leaves and files: hash of normalized lines. Modules: hash of child hashes. */
  contentHash: string;
  metrics: ChunkMetrics;
  /** Target questions per session (0 for non-leaf). */
  questionCount: number;
  isLeaf: boolean;
  /** Previous ids (move detection), most recent first, capped at 5. */
  aliases?: string[];
}

/** Version of the normalization algorithm. Bumping it forces a full rehash. */
export type NormalizationVersion = 'n1';

export interface ChunksFile {
  version: 1;
  normalization: NormalizationVersion;
  /** Sorted by id. */
  chunks: Chunk[];
}

export const MAX_ALIASES = 5;
