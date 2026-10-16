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
  /**
   * Told when git failed for a reason other than "not a repository" and the answer comes from the
   * weaker fallback (nested `.gitignore` files and global excludes are then not seen). Defaults to
   * one line on stderr: stdout may be carrying JSON-RPC or `--json` output.
   */
  onWarning?: (message: string) => void;
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
    if (Array.isArray(viaGit)) return viaGit;
    if (viaGit.warning !== null) {
      const warn = opts.onWarning ?? ((m: string) => void process.stderr.write(`gotchea: warning: ${m}\n`));
      warn(`${viaGit.warning}; checked only .gitignore and .git/info/exclude at the repository root`);
    }
  }
  return checkGitignoreFiles(root, paths);
}

/** Why git could not answer; `warning` is null when `root` is simply not a repository. */
interface GitFailure {
  warning: string | null;
}

/**
 * `git check-ignore -v -z --no-index --stdin`. Git only accepts `-z` together with `--stdin`
 * (exit 128 otherwise), and stdin also keeps long path lists clear of argv limits.
 */
function gitCheckIgnore(root: string, paths: readonly string[]): Promise<IgnoredPath[] | GitFailure> {
  return new Promise((done) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '-v', '-z', '--no-index', '--stdin'],
      // LC_ALL=C keeps git's messages in English so "not a git repository" can be recognised.
      { timeout: 10_000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        // Exit 1 means "nothing ignored"; anything else non-zero is a real failure.
        const code = (err as { code?: unknown } | null)?.code;
        if (err && code !== 1) {
          const detail = stderr.split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
          if (/not a git repository/i.test(stderr)) return done({ warning: null });
          const what = code === 'ENOENT' ? 'git was not found' : `git check-ignore failed (exit ${String(code ?? err.message)})`;
          return done({ warning: detail ? `${what}: ${detail}` : what });
        }
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
    // git may exit before reading everything (missing binary, bad repo): the callback reports
    // that, so a broken pipe here is not a second error.
    child.stdin?.on('error', () => {});
    child.stdin?.end(paths.map((p) => `${p}\0`).join(''));
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
