import { chmod, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without type declarations
import { copyWasm, GRAMMARS } from '../scripts/copy-wasm.mjs';

const wasmDir = new URL('../wasm/', import.meta.url);
const wasmPath = (name: string): string => fileURLToPath(new URL(`tree-sitter-${name}.wasm`, wasmDir));

describe('copy-wasm', () => {
  it('pins every grammar to mode 0644, even when already up to date', async () => {
    await copyWasm();
    // The second run copies nothing, so this is the "already up to date" path.
    const calls: [string, number][] = [];
    await copyWasm({ chmod: (path: string, mode: number) => void calls.push([path, mode]) });
    expect(calls).toEqual((GRAMMARS as string[]).map((name) => [wasmPath(name), 0o644]));
  });

  it('leaves no executable bits on the copied grammars', async () => {
    // POSIX: resets the 0755 below to 0644. Windows has no exec bits (files report 0666),
    // so the same assertion holds there without a platform branch.
    await chmod(wasmPath(GRAMMARS[0]), 0o755);
    await copyWasm();
    for (const name of GRAMMARS as string[]) {
      const { mode } = await stat(wasmPath(name));
      expect(mode & 0o111, name).toBe(0);
      expect(mode & 0o644, name).toBe(0o644);
    }
  });
});
