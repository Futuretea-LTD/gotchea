// Language parser contract (PLAN.md §3). Implementations wrap web-tree-sitter;
// nothing outside parse/ touches tree-sitter types directly.

export type SymbolKind = 'class' | 'function' | 'method' | 'variable' | 'other';

/** A named declaration. Lines are 1-based and inclusive (decorators/export keyword included). */
export interface SymbolNode {
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  children: SymbolNode[];
}

/** `{ start, end }` offsets into the source string (UTF-16 code units, end exclusive). */
export interface OffsetRange {
  start: number;
  end: number;
}

export interface ImportName {
  /** Exported name in the target module; 'default' for default imports. */
  imported: string;
  /** Local binding in the importing file. */
  local: string;
}

export interface ImportRef {
  /** Raw module specifier: './util', '../a/b.js', 'react', '.', '..pkg.mod', 'pkg.mod'. */
  specifier: string;
  /** Named bindings. Empty for side-effect imports and pure namespace imports. */
  names: ImportName[];
  /**
   * Namespace-style import whose members are reached through a local object:
   * `import * as x`, `export * from`, `require()`, Python `import a.b`.
   * `local` is that object's name when there is one.
   */
  namespace?: { local: string | null };
  /** 1-based line of the import statement. */
  line: number;
}

/** Opaque parse result; release it with `dispose()` when done. */
export interface ParsedFile {
  readonly text: string;
  /** True when the tree contains syntax errors (partial parse). */
  readonly hasError: boolean;
  dispose(): void;
}

export interface LanguageParser {
  /** Language id used in Chunk.lang and config `languages`: 'typescript' | 'javascript' | 'python'. */
  readonly lang: string;
  /** Lowercase extensions including the dot, e.g. ['.ts', '.mts', '.cts']. */
  readonly extensions: readonly string[];
  /** Lazily loads the WASM grammar once; safe to call repeatedly. */
  init(): Promise<void>;
  /** Requires `init()` to have resolved. */
  parse(text: string): ParsedFile;
  /** Top-level symbols in source order, with nested children. */
  symbols(f: ParsedFile): SymbolNode[];
  /** Comment offset ranges (incl. Python docstrings), sorted by start. */
  commentRanges(f: ParsedFile): OffsetRange[];
  /** 1 + decision nodes whose start line lies in [startLine, endLine] (1-based, inclusive). */
  complexity(f: ParsedFile, startLine: number, endLine: number): number;
  imports(f: ParsedFile): ImportRef[];
  /** Identifiers referenced outside import statements (for fanIn name matching). */
  identifiers(f: ParsedFile): Set<string>;
}
