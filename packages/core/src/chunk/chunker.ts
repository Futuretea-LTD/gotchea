// Content-agnostic chunking contract (PLAN.md §3). A chunker turns one source
// unit into a draft tree rooted at the file; TreeBuilder adds modules, ids,
// hashes and metrics. Code is one chunker; markdown/openapi can follow.
import type { ChunkingConfig } from '../config/schema.js';
import type { LineRange } from '../model/chunk.js';
import type { ImportRef } from '../parse/parser.js';

export interface SourceUnit {
  /** Repo-relative POSIX path. */
  path: string;
  text: string;
}

export interface ChunkDraft {
  kind: 'file' | 'group' | 'symbol';
  /** Segments below the file: [] for the file, ['Store', 'get'], ['~group:clamp'], ['~top']. */
  symbolPath: string[];
  title: string;
  ranges: LineRange[];
  /** Normalized, non-empty lines (n1). Their count is the chunk's LOC. */
  normalizedLines: string[];
  complexity: number;
  /** Empty for leaves. */
  children: ChunkDraft[];
  /** Groups only: symbol paths of the merged members, in source order. */
  members?: string[][];
}

export interface FileDraft extends ChunkDraft {
  kind: 'file';
  lang?: string;
  /** True when the file could not be parsed and was chunked as a single leaf. */
  parseFailed?: boolean;
}

export interface SourceReferences {
  imports: ImportRef[];
  /** Identifiers referenced outside import statements. */
  idents: string[];
}

export interface Chunker {
  readonly id: string;
  supports(path: string): boolean;
  /** Returns the file root draft. */
  chunk(unit: SourceUnit, cfg: ChunkingConfig): Promise<FileDraft>;
  /** Import/identifier facts used for fanIn. */
  references?(unit: SourceUnit): Promise<SourceReferences>;
}
