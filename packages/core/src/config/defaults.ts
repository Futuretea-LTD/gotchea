// Default values for the config schema (PLAN.md §3). The full default config
// object is `defaultConfig()` in load.ts, derived by parsing `{}`.

export const DEFAULT_EXCLUDE: readonly string[] = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/*.min.*',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile.lock',
];

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
];

export const DEFAULT_GENERATED_MARKERS: readonly string[] = ['@generated', 'DO NOT EDIT', 'auto-generated'];

export const DEFAULT_LANGUAGES: readonly string[] = ['typescript', 'javascript', 'python'];

export const DEFAULT_QUESTION_BANDS: readonly { maxLoc?: number; maxComplexity?: number; count: number }[] = [
  { maxLoc: 60, maxComplexity: 8, count: 3 },
  { maxLoc: 150, maxComplexity: 20, count: 5 },
  { count: 7 },
];

export const DEFAULT_QUESTION_TYPES = ['behavior', 'edge_case', 'purpose', 'impact', 'bug_detection'] as const;

/**
 * Skipped regardless of config: dependency/build dirs, lockfiles, VCS and gotchea state.
 * gitignore-style patterns (matched with the `ignore` package).
 */
export const ALWAYS_EXCLUDE: readonly string[] = [
  '.git/',
  '.gotchea/',
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '*.min.js',
  '*.min.mjs',
  '*.min.cjs',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
];
