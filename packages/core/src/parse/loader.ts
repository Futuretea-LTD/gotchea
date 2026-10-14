// Lazy, memoized loading of web-tree-sitter and the WASM grammars bundled in
// packages/core/wasm/ (PLAN.md §10, assumption 24). Paths come from ../assets.ts.
import { Language, Parser } from 'web-tree-sitter';
import { grammarPath, treeSitterRuntimePath, type GrammarName } from '../assets.js';

export type { GrammarName } from '../assets.js';

let initPromise: Promise<void> | undefined;
const grammars = new Map<GrammarName, Promise<Language>>();

/** Initializes the tree-sitter runtime once per process; safe to call repeatedly. */
export function initTreeSitter(): Promise<void> {
  // An explicit locateFile keeps the runtime WASM resolvable even if web-tree-sitter is ever bundled.
  initPromise ??= Parser.init({
    locateFile: (file: string, scriptDir: string) => (file === 'web-tree-sitter.wasm' ? treeSitterRuntimePath() : scriptDir + file),
  }).catch((err: unknown) => {
    initPromise = undefined; // allow a retry after a transient failure
    throw err;
  });
  return initPromise;
}

/** Loads (once) and returns the grammar for `name`. Initializes the runtime first. */
export function loadGrammar(name: GrammarName): Promise<Language> {
  let p = grammars.get(name);
  if (!p) {
    p = initTreeSitter()
      .then(() => Language.load(grammarPath(name)))
      .catch((err: unknown) => {
        grammars.delete(name);
        throw err;
      });
    grammars.set(name, p);
  }
  return p;
}
