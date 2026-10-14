// CodeChunker: the `code` chunker, backed by the tree-sitter parser registry.
import type { ChunkingConfig } from '../config/schema.js';
import { canonicalText, normalizeFileLines } from '../hash/normalize.js';
import { toPosixPath } from '../model/ids.js';
import type { LanguageParser, ParsedFile } from '../parse/parser.js';
import type { ParserRegistry } from '../parse/registry.js';
import type { Chunker, FileDraft, SourceReferences, SourceUnit } from './chunker.js';
import { buildFileDraft } from './grouping.js';

export class CodeChunker implements Chunker {
  readonly id = 'code';

  constructor(private readonly registry: ParserRegistry) {}

  supports(path: string): boolean {
    return this.registry.forPath(path) !== undefined;
  }

  async chunk(unit: SourceUnit, cfg: ChunkingConfig): Promise<FileDraft> {
    const path = toPosixPath(unit.path);
    const text = canonicalText(unit.text);
    const parser = this.registry.forPath(unit.path);
    const parsed = parser ? await tryParse(parser, text) : null;
    if (parser && parsed) {
      try {
        const fileLines = normalizeFileLines(text, parser.commentRanges(parsed));
        const ctx = { path, fileLines, complexity: (s: number, e: number) => parser.complexity(parsed, s, e), cfg };
        return buildFileDraft(ctx, parser.symbols(parsed), parser.lang);
      } catch {
        // Pathological input (e.g. nesting deep enough to overflow the stack): fall through.
      } finally {
        parsed.dispose();
      }
    }
    // Unparseable: one leaf for the whole file, normalized without comment stripping.
    const fileLines = normalizeFileLines(text, []);
    const draft = buildFileDraft({ path, fileLines, complexity: () => 1, cfg: { ...cfg, leafMaxLoc: Infinity } }, [], parser?.lang);
    return { ...draft, parseFailed: true };
  }

  async references(unit: SourceUnit): Promise<SourceReferences> {
    const parser = this.registry.forPath(unit.path);
    const parsed = parser ? await tryParse(parser, canonicalText(unit.text)) : null;
    if (!parser || !parsed) return { imports: [], idents: [] };
    try {
      return { imports: parser.imports(parsed), idents: [...parser.identifiers(parsed)].sort() };
    } catch {
      return { imports: [], idents: [] };
    } finally {
      parsed.dispose();
    }
  }
}

async function tryParse(parser: LanguageParser, text: string): Promise<ParsedFile | null> {
  try {
    await parser.init();
    return parser.parse(text);
  } catch {
    return null;
  }
}
