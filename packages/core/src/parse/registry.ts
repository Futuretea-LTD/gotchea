// Maps file paths to LanguageParsers by lowercase extension.
import { createJavaScriptParser, createTsxParser, createTypeScriptParser } from './lang/typescript.js';
import { createPythonParser } from './lang/python.js';
import type { LanguageParser } from './parser.js';

/** Lowercase extension of the last path segment including the dot, or '' if none. */
function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export class ParserRegistry {
  readonly #byExt = new Map<string, LanguageParser>();
  readonly #parsers: LanguageParser[] = [];

  /** Registers `p` for its extensions; a later registration wins for a shared extension. */
  register(p: LanguageParser): void {
    if (!this.#parsers.includes(p)) this.#parsers.push(p);
    for (const ext of p.extensions) this.#byExt.set(ext.toLowerCase(), p);
  }

  forPath(path: string): LanguageParser | undefined {
    const ext = extensionOf(path);
    return ext ? this.#byExt.get(ext) : undefined;
  }

  supports(path: string): boolean {
    return this.forPath(path) !== undefined;
  }

  parsers(): LanguageParser[] {
    return [...this.#parsers];
  }

  /** Loads every registered grammar. */
  async initAll(): Promise<void> {
    await Promise.all(this.#parsers.map((p) => p.init()));
  }
}

/**
 * Registry with the built-in TypeScript (.ts/.mts/.cts and .tsx), JavaScript
 * and Python parsers, optionally limited to the given language ids.
 */
export function createDefaultRegistry(languages?: readonly string[]): ParserRegistry {
  const registry = new ParserRegistry();
  const all = [createTypeScriptParser(), createTsxParser(), createJavaScriptParser(), createPythonParser()];
  for (const p of all) {
    if (!languages || languages.includes(p.lang)) registry.register(p);
  }
  return registry;
}
