import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Built from URLs, never by string concatenation: on Windows a native `C:\...` path with
// `/src/...` appended would mix separators.
const pkg = (name: string, file?: string) => fileURLToPath(new URL(`./packages/${name}${file ? `/${file}` : ''}`, import.meta.url));

// Tests import workspace packages from source, never from dist.
const alias = {
  // Before 'gotchea-core': alias keys match by prefix.
  'gotchea-core/internal': pkg('core', 'src/internal.ts'),
  'gotchea-core': pkg('core', 'src/index.ts'),
  'gotchea-mcp': pkg('mcp', 'src/index.ts'),
};

export default defineConfig({
  test: {
    // Tests load the grammars from packages/core/wasm/, exactly like the shipped package.
    globalSetup: [pkg('core', 'scripts/copy-wasm.mjs')],
    projects: ['core', 'cli', 'mcp', 'web'].map((name) => ({
      resolve: { alias },
      test: {
        name,
        root: pkg(name),
        include: ['test/**/*.test.ts'],
        // The web UI renders against a DOM; everything else is plain Node.
        environment: name === 'web' ? 'happy-dom' : 'node',
      },
    })),
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Process entry points (top-level await, no logic).
      exclude: ['packages/*/src/bin.ts', 'packages/cli/src/index.ts'],
      reporter: ['text', 'html', 'lcov'],
      // Scoring is pure math that drives every color in the map: keep it fully covered.
      thresholds: {
        'packages/core/src/score/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
