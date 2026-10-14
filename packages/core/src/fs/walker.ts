// File listing + filtering (PLAN.md §5 step 1).
//
// Listing: `git ls-files -co --exclude-standard -z` when `useGit` and
// `config.respectGitignore`; otherwise (or if git fails) a recursive directory
// walk that honors `.gitignore` at every level plus `.git/info/exclude` (only
// when `respectGitignore`), prunes ALWAYS_EXCLUDE directories without descending,
// and skips symlinks to directories.
//
// Skipped reporting: gitignored paths are never reported. In the directory walk a
// pruned ALWAYS_EXCLUDE directory is reported once as `<dir>/` with reason
// 'always' (except `.git/` and gitignored dirs, which are silent); with git listing, files inside such dirs (if git lists them) are
// reported individually. Missing files (deleted but tracked, broken symlinks)
// and non-regular files are dropped silently.
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import ignore from 'ignore';
import type { GotcheaConfig } from '../config/schema.js';
import { toPosixPath } from '../model/ids.js';
import { compareCodeUnits } from '../store/json.js';
import { ALWAYS_EXCLUDE } from '../config/defaults.js';
import { classifyContent, classifyPath, createMatcher, createPathFilters, SNIFF_BYTES, type SkipReason } from './filters.js';

export type { SkipReason } from './filters.js';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface WalkResult {
  /** Repo-relative POSIX paths, sorted by code unit. */
  files: string[];
  /** Sorted by path. */
  skipped: SkippedFile[];
  /** True when the listing came from `git ls-files`. */
  usedGit: boolean;
}

export interface WalkOptions {
  /** Try `git ls-files` first (default true). Ignored when `respectGitignore` is false. */
  useGit?: boolean;
  /** Extra per-path gate (e.g. "a parser exists"); false → 'unsupported'. */
  accept?: (path: string) => boolean;
}

const CONCURRENCY = 32;

export async function walkFiles(root: string, config: GotcheaConfig, opts: WalkOptions = {}): Promise<WalkResult> {
  const useGit = opts.useGit ?? true;
  let candidates: string[] | null = null;
  let usedGit = false;
  const skipped: SkippedFile[] = [];

  if (useGit && config.respectGitignore) {
    candidates = await gitListFiles(root);
    usedGit = candidates !== null;
  }
  if (candidates === null) {
    const walked = await walkDirectory(root, config.respectGitignore);
    candidates = walked.files;
    for (const dir of walked.prunedDirs) skipped.push({ path: dir, reason: 'always' });
  }

  const filters = createPathFilters(config);
  const realRoot = await realpath(root).catch(() => root);
  const files: string[] = [];
  const unique = [...new Set(candidates.map(toPosixPath))];

  await forEachLimit(unique, CONCURRENCY, async (path) => {
    const pathReason = classifyPath(path, filters, config, opts.accept);
    if (pathReason) {
      skipped.push({ path, reason: pathReason });
      return;
    }
    const contentReason = await classifyFile(join(root, path), realRoot, config);
    if (contentReason === 'drop') return;
    if (contentReason) skipped.push({ path, reason: contentReason });
    else files.push(path);
  });

  files.sort(compareCodeUnits);
  skipped.sort((a, b) => compareCodeUnits(a.path, b.path));
  return { files, skipped, usedGit };
}

async function classifyFile(abs: string, realRoot: string, config: GotcheaConfig): Promise<SkipReason | 'drop' | null> {
  let size: number;
  try {
    // A file symlink is followed only while its target stays inside the repo, so a
    // link to ~/.ssh/... or /etc/... never ends up in chunks or question prompts.
    if ((await lstat(abs)).isSymbolicLink() && !isInside(realRoot, await realpath(abs))) return 'outside-root';
    const st = await stat(abs);
    if (!st.isFile()) return 'drop';
    size = st.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? 'drop' : 'unreadable';
  }
  if (size > config.maxFileBytes) return 'too-large';
  let head: Uint8Array;
  try {
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return 'unreadable';
  }
  return classifyContent(head, config.generatedMarkers);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** `git ls-files -co --exclude-standard -z`, relative to `root`; null if git is unavailable or `root` is not a repo. */
export function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
      { maxBuffer: 512 * 1024 * 1024, timeout: 60_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return done(null);
        done(stdout.split('\0').filter((p) => p.length > 0));
      },
    );
  });
}

interface IgnoreLayer {
  /** Repo-relative dir of the .gitignore ('' for root). */
  base: string;
  ig: ignore.Ignore;
}

async function readIgnoreLayer(absFile: string, base: string): Promise<IgnoreLayer | null> {
  try {
    const text = await readFile(absFile, 'utf8');
    return { base, ig: ignore({ ignorecase: false, allowRelativePaths: true }).add(text) };
  } catch {
    return null;
  }
}

/** Last matching rule across layers wins (deeper files override shallower ones), like git. */
function isGitIgnored(rel: string, isDir: boolean, layers: readonly IgnoreLayer[]): boolean {
  let ignored = false;
  for (const { base, ig } of layers) {
    const local = base === '' ? rel : rel.slice(base.length + 1);
    const r = ig.test(isDir ? `${local}/` : local);
    if (r.ignored) ignored = true;
    else if (r.unignored) ignored = false;
  }
  return ignored;
}

/** Recursive walk. Returns candidate files plus ALWAYS_EXCLUDE dirs that were pruned (as `dir/`). */
export async function walkDirectory(
  root: string,
  respectGitignore: boolean,
): Promise<{ files: string[]; prunedDirs: string[] }> {
  const always = createMatcher(ALWAYS_EXCLUDE);
  const files: string[] = [];
  const prunedDirs: string[] = [];

  const rootLayers: IgnoreLayer[] = [];
  if (respectGitignore) {
    const exclude = await readIgnoreLayer(join(root, '.git', 'info', 'exclude'), '');
    if (exclude) rootLayers.push(exclude);
  }

  const visit = async (rel: string, inherited: readonly IgnoreLayer[]): Promise<void> => {
    const abs = rel === '' ? root : join(root, rel);
    let layers = inherited;
    if (respectGitignore) {
      const own = await readIgnoreLayer(join(abs, '.gitignore'), rel);
      if (own) layers = [...inherited, own];
    }
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          if ((await stat(join(abs, e.name))).isDirectory()) continue; // avoid cycles
        } catch {
          // broken link: let the filter stage drop it
        }
        isDir = false;
      } else if (!isDir && !e.isFile()) {
        continue;
      }
      if (isDir) {
        if (always(`${childRel}/`)) {
          const quiet = e.name === '.git' || (respectGitignore && isGitIgnored(childRel, true, layers));
          if (!quiet) prunedDirs.push(`${childRel}/`);
          continue;
        }
        if (respectGitignore && isGitIgnored(childRel, true, layers)) continue;
        subdirs.push(childRel);
      } else {
        if (respectGitignore && isGitIgnored(childRel, false, layers)) continue;
        files.push(childRel);
      }
    }
    for (const d of subdirs) await visit(d, layers);
  };

  await visit('', rootLayers);
  return { files, prunedDirs };
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
