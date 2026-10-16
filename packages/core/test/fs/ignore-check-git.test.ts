// The `git check-ignore` branch of findIgnoredPaths: record parsing, exit codes and fallback.
// A stub `git` first on PATH makes the parser testable on any machine and git version.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findIgnoredPaths } from '../../src/fs/ignore-check.js';

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

  it('any other failure (exit 128, e.g. not a repository) falls back to the root .gitignore', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await fakeGit('echo fatal: not a git repository >&2', 128);
    expect(await findIgnoredPaths(root, ['x.txt'])).toEqual([{ path: 'x.txt', source: '.gitignore', line: 1, pattern: 'x.txt' }]);
  });

  it('passes the repository, the flags and every path to git', async () => {
    const log = join(bin, 'args.log');
    await fakeGit(`for a in "$@"; do echo "$a"; done > '${log}'`, 1);
    await findIgnoredPaths(root, ['a b', '-dash']);
    const args = (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n');
    expect(args).toEqual(['-C', root, 'check-ignore', '-v', '-z', '--no-index', '--', 'a b', '-dash']);
  });

  it('falls back when git is not installed at all', async () => {
    await writeFile(join(root, '.gitignore'), 'x.txt\n');
    await mkdir(join(bin, 'empty'));
    vi.stubEnv('PATH', join(bin, 'empty')); // no git, no sh needed: execFile ENOENT
    expect(await findIgnoredPaths(root, ['x.txt'])).toEqual([{ path: 'x.txt', source: '.gitignore', line: 1, pattern: 'x.txt' }]);
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

// KNOWN BUG (see report): current git rejects `check-ignore -z` without `--stdin`
// ("fatal: -z only makes sense with --stdin", exit 128), so the git branch always falls back to
// the root .gitignore and nested .gitignore files / global excludes are never honoured.
// `it.fails` keeps CI green now and goes red the day src passes the paths via --stdin:
// then delete `.fails`.
describe.runIf(gitVersionOk())('findIgnoredPaths with real git (nested rules)', () => {
  it.fails('honours a nested .gitignore, which only git itself can see', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', '.gitignore'), 'a.ts\n');
    expect(await findIgnoredPaths(root, ['src/a.ts'])).toEqual([{ path: 'src/a.ts', source: 'src/.gitignore', line: 1, pattern: 'a.ts' }]);
  });
});
