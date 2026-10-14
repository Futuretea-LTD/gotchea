// Path filters for the file walker (PLAN.md §5 step 1). Globs use gitignore
// semantics via the `ignore` package: `**/x/**` matches at any depth (incl. the
// root), `**/*` matches everything, a pattern ending in `/` matches directories.
import ignore from 'ignore';
import { ALWAYS_EXCLUDE } from '../config/defaults.js';
import type { GotcheaConfig } from '../config/schema.js';

export type SkipReason =
  | 'always'
  | 'excluded'
  | 'not-included'
  | 'test'
  | 'unsupported'
  | 'too-large'
  | 'generated'
  | 'binary'
  | 'unreadable'
  /** A symlink whose target resolves outside the repository root. */
  | 'outside-root';

export type PathMatcher = (path: string) => boolean;

/**
 * Returns a predicate that is true when a repo-relative POSIX path matches any of
 * `patterns` (gitignore-style; a match on a parent directory counts). A path ending
 * in `/` is tested as a directory. Matching is case-sensitive. No patterns → never matches.
 */
export function createMatcher(patterns: readonly string[]): PathMatcher {
  const active = patterns.filter((p) => p.trim().length > 0);
  if (active.length === 0) return () => false;
  const ig = ignore({ ignorecase: false, allowRelativePaths: true }).add([...active]);
  return (path: string) => {
    const p = stripDotSlash(path);
    return p.length > 0 && p !== '/' && ig.ignores(p);
  };
}

function stripDotSlash(p: string): string {
  let out = p;
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/^\/+/, '');
}

export interface PathFilters {
  always: PathMatcher;
  include: PathMatcher;
  excluded: PathMatcher;
  test: PathMatcher;
}

export function createPathFilters(config: GotcheaConfig): PathFilters {
  return {
    always: createMatcher(ALWAYS_EXCLUDE),
    include: createMatcher(config.include),
    excluded: createMatcher([...config.exclude, ...config.ignore]),
    test: createMatcher(config.testPatterns),
  };
}

/**
 * Path-only checks, in order: always-excluded, include, exclude/ignore, tests, `accept`.
 * Returns the skip reason or `null` if the path passes.
 */
export function classifyPath(
  path: string,
  filters: PathFilters,
  config: GotcheaConfig,
  accept?: (path: string) => boolean,
): SkipReason | null {
  if (filters.always(path)) return 'always';
  if (!filters.include(path)) return 'not-included';
  if (filters.excluded(path)) return 'excluded';
  if (!config.includeTests && filters.test(path)) return 'test';
  if (accept && !accept(path)) return 'unsupported';
  return null;
}

/** Number of leading bytes inspected for NUL bytes and generated markers. */
export const SNIFF_BYTES = 4096;
/** Generated markers are only honored in this many leading lines. */
export const GENERATED_MARKER_LINES = 5;

/** Content checks on the first bytes of a file: NUL → binary; marker in first 5 lines → generated. */
export function classifyContent(head: Uint8Array, markers: readonly string[]): 'binary' | 'generated' | null {
  if (head.includes(0)) return 'binary';
  if (markers.length === 0) return null;
  const text = Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString('utf8');
  const lines = text.split(/\r\n|\r|\n/, GENERATED_MARKER_LINES);
  for (const line of lines) {
    for (const m of markers) if (m.length > 0 && line.includes(m)) return 'generated';
  }
  return null;
}
