// Which repo-relative paths would git ignore? Used by `gotchea init` to make sure
// `.gotchea/` (shared, committed state) is not swallowed by a `.gitignore` rule.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';

export interface IgnoredPath {
  path: string;
  /** File holding the matching rule (repo-relative for repo files); null if unknown. */
  source: string | null;
  /** 1-based line of the rule in `source`; null if unknown. */
  line: number | null;
  pattern: string | null;
}

export interface IgnoreCheckOptions {
  /** Ask git first (default true); falls back to the root `.gitignore` when git is unavailable. */
  useGit?: boolean;
}

/**
 * Returns the subset of `paths` that are ignored. Rules are evaluated even for tracked
 * files (`--no-index`), since the question is whether the rules exclude them.
 */
export async function findIgnoredPaths(
  root: string,
  paths: readonly string[],
  opts: IgnoreCheckOptions = {},
): Promise<IgnoredPath[]> {
  if (paths.length === 0) return [];
  if (opts.useGit !== false) {
    const viaGit = await gitCheckIgnore(root, paths);
    if (viaGit !== null) return viaGit;
  }
  return checkGitignoreFiles(root, paths);
}

/** `git check-ignore -v -z --no-index`; null when git is unavailable or `root` is not a repo. */
function gitCheckIgnore(root: string, paths: readonly string[]): Promise<IgnoredPath[] | null> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', root, 'check-ignore', '-v', '-z', '--no-index', '--', ...paths],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        // Exit 1 means "nothing ignored"; anything else non-zero is a real failure.
        const code = (err as { code?: unknown } | null)?.code;
        if (err && code !== 1) return done(null);
        // Records: <source> NUL <line> NUL <pattern> NUL <path> NUL
        const f = stdout.split('\0');
        const out: IgnoredPath[] = [];
        for (let i = 0; i + 3 < f.length; i += 4) {
          const pattern = f[i + 2]!;
          if (pattern.startsWith('!')) continue; // matched a negation: not ignored
          out.push({ path: f[i + 3]!, source: f[i]! || null, line: Number(f[i + 1]) || null, pattern: pattern || null });
        }
        done(out);
      },
    );
  });
}

/** Fallback without git: `.git/info/exclude` plus the root `.gitignore`, last match wins. */
async function checkGitignoreFiles(root: string, paths: readonly string[]): Promise<IgnoredPath[]> {
  const sources: { source: string; lines: string[] }[] = [];
  for (const source of ['.git/info/exclude', '.gitignore']) {
    try {
      sources.push({ source, lines: (await readFile(join(root, source), 'utf8')).split(/\r?\n/) });
    } catch {
      // missing file: no rules
    }
  }
  const out: IgnoredPath[] = [];
  for (const path of paths) {
    let hit: IgnoredPath | null = null;
    for (const { source, lines } of sources) {
      lines.forEach((pattern, idx) => {
        if (pattern.trim() === '' || pattern.startsWith('#')) return;
        const negated = pattern.startsWith('!');
        const ig = ignore({ ignorecase: false, allowRelativePaths: true }).add(negated ? pattern.slice(1) : pattern);
        if (!ig.ignores(path)) return;
        hit = negated ? null : { path, source, line: idx + 1, pattern };
      });
    }
    if (hit) out.push(hit);
  }
  return out;
}
