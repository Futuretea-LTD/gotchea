// Runtime paths to the WASM files gotchea-core ships or depends on.
//
// This module must stay at the top of src/: tsup bundles it into dist/index.js,
// so `import.meta.url` is src/assets.ts in tests and dist/index.js when built or
// installed. Both sit one level below the package root, which makes `../wasm/`
// the package's own wasm/ folder (see scripts/copy-wasm.mjs) in every layout.
// Never resolve these against process.cwd().
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python';

const require = createRequire(import.meta.url);

/** Absolute path of the bundled grammar for `name`. */
export function grammarPath(name: GrammarName): string {
  return fileURLToPath(new URL(`../wasm/tree-sitter-${name}.wasm`, import.meta.url));
}

/** Absolute path of web-tree-sitter's runtime WASM inside the resolved web-tree-sitter package. */
export function treeSitterRuntimePath(): string {
  return require.resolve('web-tree-sitter/web-tree-sitter.wasm');
}
