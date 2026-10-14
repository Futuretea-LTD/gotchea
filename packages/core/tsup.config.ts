import { defineConfig } from 'tsup';

// JS only; declarations are emitted by `tsc -p tsconfig.build.json`.
// Entries are flat on purpose: src/assets.ts and src/index.ts resolve `../wasm/` and
// `../package.json` from import.meta.url, which only works while every bundled
// module (including shared chunks) sits directly in dist/.
export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
});
