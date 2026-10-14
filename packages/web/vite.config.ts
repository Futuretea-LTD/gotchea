import { defineConfig } from 'vite';

// Served by `gotchea serve` from packages/cli/dist/web/ under `default-src 'self'`:
// absolute asset URLs (the server falls back to index.html for any path), and no
// data: URIs, which that CSP would block.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2022',
    sourcemap: false,
  },
});
