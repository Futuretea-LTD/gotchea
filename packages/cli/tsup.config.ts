import { defineConfig } from 'tsup';

// JS only; declarations are emitted by `tsc -p tsconfig.build.json`.
// index.ts is the bin: tsup keeps its shebang and marks the output executable.
// Workspace packages (gotchea-core, gotchea-mcp) stay external so their WASM
// assets resolve relative to the package that ships them.
export default defineConfig({
  entry: ['src/index.ts', 'src/program.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  external: ['gotchea-core', 'gotchea-mcp'],
});
