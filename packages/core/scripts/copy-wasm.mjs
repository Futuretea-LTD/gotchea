// Copies the grammar WASM files gotchea-core needs from @vscode/tree-sitter-wasm
// (a devDependency, ~21 MB for ~20 grammars) into packages/core/wasm/, which is
// shipped in the tarball. Runs before `build` and as a vitest global setup.
import { chmodSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Keep in sync with GrammarName in src/assets.ts.
export const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python'];

const require = createRequire(import.meta.url);
const outDir = new URL('../wasm/', import.meta.url);

/** `chmod` is injectable because Windows ignores POSIX modes, so only the call itself can be checked there. */
export async function copyWasm({ chmod = chmodSync } = {}) {
  await mkdir(outDir, { recursive: true });
  for (const name of GRAMMARS) {
    const file = `tree-sitter-${name}.wasm`;
    const src = require.resolve(`@vscode/tree-sitter-wasm/wasm/${file}`);
    const dest = fileURLToPath(new URL(file, outDir));
    const [a, b] = await Promise.all([stat(src), stat(dest).catch(() => null)]);
    if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) await copyFile(src, dest);
    // copyFile keeps the source mode, which depends on how the package manager
    // extracted it; pin 0644 so the tarball never ships executable or private WASM.
    chmod(dest, 0o644);
  }
}

// vitest globalSetup entry (see vitest.config.ts). A wrapper, because vitest passes
// its project object as the first argument.
export async function setup() {
  await copyWasm();
}

/** True when this file is the process entry (`node scripts/copy-wasm.mjs`). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    // Real paths on both sides: the module URL is already resolved, argv[1] is not
    // (symlinks, 8.3 short names); Windows also differs in drive-letter case.
    const a = realpathSync(fileURLToPath(import.meta.url));
    const b = realpathSync(process.argv[1]);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain()) await copyWasm();
