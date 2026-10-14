import { defineConfig } from 'tsup';

// JS only; declarations are emitted by `tsc -p tsconfig.build.json`.
// tsup keeps the bin.ts shebang and marks the output executable.
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  external: ['gotchea-core'],
});
