import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { MarkdownReporter } from './src/reporter.js';

export default defineConfig({
  test: {
    name: 'e2e',
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default', new MarkdownReporter()],
  },
});
