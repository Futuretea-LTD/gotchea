// Shared helpers for tree-sitter backed LanguageParser implementations.
// Tree-sitter types never leave parse/: ParsedFile is opaque to callers.
import { Parser } from 'web-tree-sitter';
import type { Language, Node, Tree, TreeCursor } from 'web-tree-sitter';
import { loadGrammar } from './loader.js';
import type { GrammarName } from './loader.js';
import type { ImportRef, LanguageParser, OffsetRange, ParsedFile, SymbolNode } from './parser.js';

/** Concrete ParsedFile holding the tree-sitter tree. */
export class TreeParsedFile implements ParsedFile {
  #tree: Tree | null;
  readonly text: string;
  readonly hasError: boolean;

  constructor(text: string, tree: Tree) {
    this.text = text;
    this.#tree = tree;
    this.hasError = tree.rootNode.hasError;
  }

  get root(): Node {
    if (!this.#tree) throw new Error('ParsedFile has been disposed');
    return this.#tree.rootNode;
  }

  dispose(): void {
    this.#tree?.delete();
    this.#tree = null;
  }
}

export function rootOf(f: ParsedFile): Node {
  if (!(f instanceof TreeParsedFile)) throw new TypeError('ParsedFile was not produced by a tree-sitter parser');
  return f.root;
}

/** 1-based first line of a node. */
export function startLine(n: Node): number {
  return n.startPosition.row + 1;
}

/** 1-based last line of a node; a node ending at column 0 does not count that row. */
export function endLine(n: Node): number {
  const { row, column } = n.endPosition;
  return column === 0 && row > n.startPosition.row ? row : row + 1;
}

export function symbol(name: string, kind: SymbolNode['kind'], from: Node, to: Node, children: SymbolNode[] = []): SymbolNode {
  return { name, kind, start: startLine(from), end: Math.max(startLine(from), endLine(to)), children };
}

/**
 * Pre-order walk with a TreeCursor (no recursion, so deep trees are safe).
 * `visit` returns true to descend into the current node's children.
 */
export function walk(root: Node, visit: (c: TreeCursor) => boolean): void {
  const c = root.walk();
  try {
    let descend = visit(c);
    for (;;) {
      if (descend && c.gotoFirstChild()) {
        descend = visit(c);
        continue;
      }
      while (!c.gotoNextSibling()) {
        if (!c.gotoParent()) return;
      }
      descend = visit(c);
    }
  } finally {
    c.delete();
  }
}

/** Collects offset ranges of nodes whose type is in `types` (sorted by start). */
export function collectRanges(root: Node, types: ReadonlySet<string>): OffsetRange[] {
  const out: OffsetRange[] = [];
  walk(root, (c) => {
    if (types.has(c.nodeType)) {
      out.push({ start: c.startIndex, end: c.endIndex });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * 1 + number of nodes accepted by `isDecision` whose start line is in
 * [startLine, endLine]. Subtrees entirely outside the window are skipped.
 */
export function countDecisions(root: Node, from: number, to: number, isDecision: (c: TreeCursor) => boolean): number {
  const lo = from - 1;
  const hi = to - 1;
  let count = 1;
  if (hi < lo) return count;
  walk(root, (c) => {
    if (c.startPosition.row > hi || c.endPosition.row < lo) return false;
    if (c.startPosition.row >= lo && isDecision(c)) count++;
    return true;
  });
  return count;
}

/** Text of a string literal node without its quotes. */
export function stringContent(n: Node): string {
  const t = n.text;
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'" || q === '`') && t.endsWith(q)) return t.slice(1, -1);
  }
  return t;
}

/** Base class: grammar loading, parsing and ParsedFile unwrapping. */
export abstract class TreeSitterLanguageParser implements LanguageParser {
  abstract readonly lang: string;
  abstract readonly extensions: readonly string[];
  protected abstract readonly grammar: GrammarName;
  #parser: Parser | null = null;
  #initPromise: Promise<void> | undefined;

  init(): Promise<void> {
    this.#initPromise ??= loadGrammar(this.grammar).then(
      (language: Language) => {
        const p = new Parser();
        p.setLanguage(language);
        this.#parser = p;
      },
      (err: unknown) => {
        this.#initPromise = undefined;
        throw err;
      },
    );
    return this.#initPromise;
  }

  parse(text: string): ParsedFile {
    if (!this.#parser) throw new Error(`${this.lang} parser (${this.grammar}) used before init() resolved`);
    const tree = this.#parser.parse(text);
    if (!tree) throw new Error(`tree-sitter returned no tree for ${this.grammar} input`);
    return new TreeParsedFile(text, tree);
  }

  abstract symbols(f: ParsedFile): SymbolNode[];
  abstract commentRanges(f: ParsedFile): OffsetRange[];
  abstract complexity(f: ParsedFile, startLine: number, endLine: number): number;
  abstract imports(f: ParsedFile): ImportRef[];
  abstract identifiers(f: ParsedFile): Set<string>;
}
