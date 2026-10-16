// The `git check-ignore` branch of findIgnoredPaths: record parsing, exit codes and fallback.
// A stub `git` first on PATH makes the parser testable on any machine and git version.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findIgnoredPaths } from '../../src/fs/ignore-check.js';
import { scanRepo } from '../../src/scan/scan.js';

let root: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotchea-ignore-git-'));
  bin = await mkdtemp(join(tmpdir(), 'gotchea-fake-git-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(bin, { recursive: true, force: true, maxRetries: 5 });
});

/** Installs a `git` that prints `body` (a POSIX sh snippet) and exits with `code`. */
async function fakeGit(body: string, code = 0): Promise<void> {
  await writeFile(join(bin, 'git'), `#!/bin/sh\n${body}\nexit ${code}\n`);
  await chmod(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
}

describe.runIf(process.platform !== 'win32')('findIgnoredPaths: git output handling', () => {
  it('parses NUL-separated <source, line, pattern, path> records and skips negations', async () => {
    await fakeGit(
      [
        "printf '%s\\0%s\\0%s\\0%s\\0' .gitignore 1 '.gotchea/*' .gotchea/questions/",
        "printf '%s\\0%s\\0%s\\0%s\\0' .gitignore 2 '!.gotchea/config.json' .gotchea/config.json",
        "printf '%s\\0%s\\0%s\\0%s\\0' /home/u/.config/git/ignore 7 '*.log' a.log",
      ].join('\n'),
    );
    const out = await findIgnoredPaths(root, ['.gotchea/questions/', '.gotchea/config.json', 'a.log']);
    expect(out).toEqual([
      { path: '.gotchea/questions/', source: '.gitignore', line: 1, pattern: '.gotchea/*' },
      { path: 'a.log', source: '/home/u/.config/git/ignore', line: 7, pattern: '*.log' },
    ]);
  });

  it('maps empty source / line / pattern fields to null', async () => {
    await fakeGit("printf '%s\\0%s\\0%s\\0%s\\0' '' '' '' x.txt");
    expect(await findIgnoredPaths(root, ['x.txt'])).toEqual([{ path: 'x.txt', source: null, line: null, pattern: null }]);
  });

  it('exit 1 with no output means nothing is ignored, and the .gitignore fallback is NOT consulted', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await fakeGit(':', 1);
    expect(await findIgnoredPaths(root, ['x.txt'])).toEqual([]);
  });

  it('outside a repository (exit 128) falls back to the root .gitignore without a warning', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await fakeGit('echo "fatal: not a git repository (or any of the parent directories): .git" >&2', 128);
    const onWarning = vi.fn();
    expect(await findIgnoredPaths(root, ['x.txt'], { onWarning })).toEqual([{ path: 'x.txt', source: '.gitignore', line: 1, pattern: 'x.txt' }]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('any other failure falls back to the root .gitignore and warns with the exit code and first stderr line', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await fakeGit("printf '\\nfatal: -z only makes sense with --stdin\\nmore\\n' >&2", 128);
    const onWarning = vi.fn();
    expect(await findIgnoredPaths(root, ['x.txt'], { onWarning })).toEqual([{ path: 'x.txt', source: '.gitignore', line: 1, pattern: 'x.txt' }]);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toBe(
      'git check-ignore failed (exit 128): fatal: -z only makes sense with --stdin; checked only .gitignore and .git/info/exclude at the repository root',
    );
  });

  it('warns on stderr, never stdout, when no onWarning is given', async () => {
    await fakeGit(':', 2);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write');
    try {
      expect(await findIgnoredPaths(root, ['x.txt'])).toEqual([]);
      expect(err).toHaveBeenCalledWith(
        'gotchea: warning: git check-ignore failed (exit 2); checked only .gitignore and .git/info/exclude at the repository root\n',
      );
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it('passes the repository and the flags as arguments, and every path NUL-terminated on stdin', async () => {
    const log = join(bin, 'args.log');
    const input = join(bin, 'stdin.bin');
    await fakeGit(`for a in "$@"; do echo "$a"; done > '${log}'\ncat > '${input}'`, 1);
    await findIgnoredPaths(root, ['a b', '-dash', 'new\nline']);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['-C', root, 'check-ignore', '-v', '-z', '--no-index', '--stdin']);
    expect(readFileSync(input, 'utf8')).toBe('a b\0-dash\0new\nline\0');
  });

  it('streams a path list far beyond the argv limit', async () => {
    const input = join(bin, 'stdin.bin');
    await fakeGit(`cat > '${input}'`, 1);
    const paths = Array.from({ length: 50_000 }, (_, i) => `src/some/deeply/nested/directory/file-${i}.ts`);
    expect(await findIgnoredPaths(root, paths)).toEqual([]);
    expect((await import('node:fs')).readFileSync(input, 'utf8').split('\0')).toHaveLength(paths.length + 1);
  });

  it('falls back when git is not installed at all', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await mkdir(join(bin, 'empty'));
    vi.stubEnv('PATH', join(bin, 'empty')); // no git, no sh needed: execFile ENOENT
    const onWarning = vi.fn();
    expect(await findIgnoredPaths(root, ['x.txt'], { onWarning })).toEqual([{ path: 'x.txt', source: '.gitignore', line: 1, pattern: 'x.txt' }]);
    expect(onWarning).toHaveBeenCalledWith('git was not found; checked only .gitignore and .git/info/exclude at the repository root');
  });
});

function gitVersionOk(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** `git init` in `root`, isolated from the user's global excludes (see walker.test.ts). */
async function initRepo(): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: root });
  const noExcludes = join(root, '.git', 'no-excludes');
  await writeFile(noExcludes, '');
  execFileSync('git', ['config', 'core.excludesFile', noExcludes], { cwd: root });
}

// Regression: git rejects `check-ignore -z` without `--stdin` (exit 128), which used to send every
// call down the root-only fallback, silently missing nested .gitignore files and global excludes.
describe.runIf(gitVersionOk())('findIgnoredPaths with real git (nested rules)', () => {
  it('honours a nested .gitignore, which only git itself can see', async () => {
    await initRepo();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', '.gitignore'), 'a.ts\n');
    const onWarning = vi.fn();
    expect(await findIgnoredPaths(root, ['src/a.ts', 'src/b.ts'], { onWarning })).toEqual([
      { path: 'src/a.ts', source: 'src/.gitignore', line: 1, pattern: 'a.ts' },
    ]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('honours the global core.excludesFile', async () => {
    await initRepo();
    const global = join(bin, 'global-ignore');
    await writeFile(global, '*.secret\n');
    execFileSync('git', ['config', 'core.excludesFile', global], { cwd: root });
    const out = await findIgnoredPaths(root, ['k.secret', 'k.ts']);
    expect(out.map((h) => [h.path, h.pattern])).toEqual([['k.secret', '*.secret']]);
  });

  it('returns nothing (exit 1) when no rule matches, without warning', async () => {
    await initRepo();
    const onWarning = vi.fn();
    expect(await findIgnoredPaths(root, ['src/a.ts'], { onWarning })).toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });
});

// What generate actually sends to the model is decided by the scan's file walk, so the
// same rules are pinned end to end there.
describe.runIf(gitVersionOk())('scanRepo with real git: ignored files never become chunks', () => {
  it('drops files matched only by a nested .gitignore or by .git/info/exclude', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gotchea-ignore-home-'));
    try {
      await initRepo();
      await mkdir(join(root, 'src', 'sub'), { recursive: true });
      const fn = (name: string) => `export function ${name}(a: number): number {\n  return a + 1;\n}\n`;
      await writeFile(join(root, 'src', 'kept.ts'), fn('kept'));
      await writeFile(join(root, 'src', 'sub', '.gitignore'), 'nested-secret.ts\n');
      await writeFile(join(root, 'src', 'sub', 'nested-secret.ts'), fn('nestedSecret'));
      await writeFile(join(root, '.git', 'info', 'exclude'), 'src/local-secret.ts\n');
      await writeFile(join(root, 'src', 'local-secret.ts'), fn('localSecret'));

      const r = await scanRepo({ root, repoId: 'ignore-test', env: { GOTCHEA_HOME: home }, dryRun: true });
      expect(r.files).toEqual(['src/kept.ts']);
      expect(new Set(r.chunks.flatMap((c) => c.ranges.map((range) => range.path)))).toEqual(new Set(['src/kept.ts']));
      expect(r.skipped.map((s) => s.path)).not.toContain('src/sub/nested-secret.ts');
      expect(r.skipped.map((s) => s.path)).not.toContain('src/local-secret.ts');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
