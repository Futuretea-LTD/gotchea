// Copies the grammar WASM files gotchea-core needs from @vscode/tree-sitter-wasm
// (a devDependency, ~21 MB for ~20 grammars) into packages/core/wasm/, which is
// shipped in the tarball. Runs before `build` and as a vitest global setup.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Keep in sync with GrammarName in src/assets.ts.
export const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python'];

const require = createRequire(import.meta.url);
const outDir = new URL('../wasm/', import.meta.url);

export async function copyWasm() {
  await mkdir(outDir, { recursive: true });
  for (const name of GRAMMARS) {
    const file = `tree-sitter-${name}.wasm`;
    const src = require.resolve(`@vscode/tree-sitter-wasm/wasm/${file}`);
    const dest = fileURLToPath(new URL(file, outDir));
    const [a, b] = await Promise.all([stat(src), stat(dest).catch(() => null)]);
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
    await copyFile(src, dest);
  }
}

// vitest globalSetup entry (see vitest.config.ts).
export { copyWasm as setup };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await copyWasm();
