// Working-tree reads for generation (M2_DESIGN.md §3.1, §8.2): the chunk's current
// hash (re-chunks one file), raw lines and the import-signature context. One
// `SourceReader` caches per file, so a call that touches many chunks parses each file once.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkDraft, FileDraft, SourceReferences } from '../chunk/chunker.js';
import { CodeChunker } from '../chunk/code-chunker.js';
import { resolveImport } from '../chunk/fanin.js';
import type { GotcheaConfig } from '../config/schema.js';
import { contentHash, lineFingerprints } from '../hash/hash.js';
import type { Chunk, LineRange } from '../model/chunk.js';
import { symbolChunkId } from '../model/ids.js';
import { createDefaultRegistry } from '../parse/registry.js';
import { type ChunkCode, numberChunkCode, splitSourceLines } from './chunk-code.js';
import type { ImportSignature } from './tasks.js';

const MAX_IMPORTS = 20;
const MAX_IMPORT_CHARS = 4000;
const MAX_SIGNATURE_CHARS = 200;

// Grammars load once per process and language set, not once per tool call.
const chunkers = new Map<string, CodeChunker>();
function chunkerFor(languages: readonly string[]): CodeChunker {
  const key = [...languages].sort().join(',');
  let c = chunkers.get(key);
  if (!c) {
    c = new CodeChunker(createDefaultRegistry([...languages]));
    chunkers.set(key, c);
  }
  return c;
}

export class SourceReader {
  private readonly texts = new Map<string, Promise<string>>();
  private readonly drafts = new Map<string, Promise<FileDraft>>();
  private readonly refs = new Map<string, Promise<SourceReferences>>();
  private readonly chunker: CodeChunker;

  constructor(
    readonly root: string,
    private readonly config: Pick<GotcheaConfig, 'languages' | 'chunking'>,
  ) {
    this.chunker = chunkerFor(config.languages);
  }

  private text(path: string): Promise<string> {
    return memo(this.texts, path, () => readFile(join(this.root, path), 'utf8'));
  }

  async lines(path: string): Promise<string[]> {
    return splitSourceLines(await this.text(path));
  }

  draft(path: string): Promise<FileDraft> {
    return memo(this.drafts, path, async () => this.chunker.chunk({ path, text: await this.text(path) }, this.config.chunking));
  }

  references(path: string): Promise<SourceReferences> {
    return memo(this.refs, path, async () =>
      this.chunker.references ? this.chunker.references({ path, text: await this.text(path) }) : { imports: [], idents: [] },
    );
  }

  /** Numbered code over the chunk's ranges, read from the working tree. */
  async chunkCode(chunk: Pick<Chunk, 'ranges'>): Promise<ChunkCode> {
    const rangeLines: string[][] = [];
    for (const r of chunk.ranges) rangeLines.push((await this.lines(r.path)).slice(r.start - 1, r.end));
    return numberChunkCode(rangeLines);
  }

  /**
   * The chunk's contentHash as a scan would compute it now, by re-chunking only its
   * file. Null when the file is gone, no longer yields a chunk with this id, or the
   * chunk sits at other lines than in chunks.json: the hash ignores comments and blank
   * lines, but the numbered code is read from the scanned ranges, so a shift (e.g. a
   * comment added above) would show the generator the wrong lines until the next scan.
   */
  async currentHash(chunk: Pick<Chunk, 'id' | 'ranges'>): Promise<string | null> {
    const found = await this.currentDraft(chunk);
    return found ? contentHash(found.normalizedLines) : null;
  }

  /** Line fingerprints of the chunk as a scan would compute them now; null under the same conditions as `currentHash`. */
  async fingerprints(chunk: Pick<Chunk, 'id' | 'ranges'>): Promise<string[] | null> {
    const found = await this.currentDraft(chunk);
    return found ? lineFingerprints(found.normalizedLines) : null;
  }

  private async currentDraft(chunk: Pick<Chunk, 'id' | 'ranges'>): Promise<ChunkDraft | null> {
    const path = chunk.ranges[0]?.path;
    if (!path) return null;
    let draft: FileDraft;
    try {
      draft = await this.draft(path);
    } catch {
      return null;
    }
    const found = findDraft(draft, (d) => symbolChunkId(path, d.symbolPath) === chunk.id);
    return found && sameRanges(found.ranges, chunk.ranges) ? found : null;
  }
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = load();
    cache.set(key, p);
  }
  return p;
}

function sameRanges(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.path === b[i]!.path && r.start === b[i]!.start && r.end === b[i]!.end);
}

function findDraft(d: ChunkDraft, pred: (d: ChunkDraft) => boolean): ChunkDraft | null {
  if (pred(d)) return d;
  for (const c of d.children) {
    const hit = findDraft(c, pred);
    if (hit) return hit;
  }
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Declaration head starting at `lines[i]`: up to the first line with `{` or `:`, capped. */
function declarationHead(lines: readonly string[], i: number): string {
  const out: string[] = [];
  for (let k = i; k < lines.length && k < i + 10; k++) {
    const line = lines[k]!.trim();
    if (line === '') continue;
    out.push(line);
    if (/[{:]/.test(line)) break;
  }
  const head = out.join(' ').replace(/\s+/g, ' ');
  return head.length > MAX_SIGNATURE_CHARS ? `${head.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : head;
}

/** First declaration of `name` in a file (TS/JS/Python), or '' when none is found. */
function findSignature(lines: readonly string[], name: string): string {
  const re =
    name === 'default'
      ? /^\s*export\s+default\b/
      : new RegExp(
          `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|interface|type|enum|def)\\s+${escapeRe(name)}\\b`,
        );
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? '' : declarationHead(lines, i);
}

/**
 * Imports of the chunk's file that the chunk's own lines reference, with the
 * declaration head of each resolved symbol (§3.1). External or unresolved imports get
 * an empty signature. Capped at 20 entries / 4000 chars.
 */
export async function importSignatures(
  reader: SourceReader,
  chunk: Pick<Chunk, 'ranges' | 'lang'>,
  code: ChunkCode,
  knownFiles: ReadonlySet<string>,
): Promise<ImportSignature[]> {
  const path = chunk.ranges[0]?.path;
  if (!path) return [];
  const { imports } = await reader.references(path);
  const body = code.lines.join('\n');
  const uses = (local: string) => new RegExp(`(^|[^\\w$])${escapeRe(local)}($|[^\\w$])`).test(body);

  const out: ImportSignature[] = [];
  let chars = 0;
  const push = (sig: ImportSignature): boolean => {
    const size = sig.from.length + sig.name.length + sig.signature.length;
    if (out.length >= MAX_IMPORTS || chars + size > MAX_IMPORT_CHARS) return false;
    if (out.some((o) => o.from === sig.from && o.name === sig.name)) return true;
    out.push(sig);
    chars += size;
    return true;
  };

  for (const ref of imports) {
    const target = resolveImport(path, chunk.lang ?? '', ref.specifier, knownFiles);
    const targetLines = target ? await reader.lines(target).catch(() => null) : null;
    for (const n of ref.names) {
      if (!uses(n.local)) continue;
      const signature = targetLines ? findSignature(targetLines, n.imported) : '';
      if (!push({ from: ref.specifier, name: n.local, signature })) return out;
    }
    const ns = ref.namespace?.local;
    if (ns && uses(ns) && !push({ from: ref.specifier, name: ns, signature: '' })) return out;
  }
  return out;
}

/** Declaration line of the enclosing symbol for methods (e.g. `class SessionStore {`), else null. */
export async function enclosingDeclaration(reader: SourceReader, parent: Pick<Chunk, 'kind' | 'ranges'> | undefined): Promise<string | null> {
  const r = parent?.kind === 'symbol' ? parent.ranges[0] : undefined;
  if (!r) return null;
  const lines = await reader.lines(r.path).catch(() => null);
  if (!lines) return null;
  for (let i = r.start - 1; i < Math.min(r.end, lines.length); i++) {
    if (lines[i]!.trim() !== '') return declarationHead(lines, i);
  }
  return null;
}
