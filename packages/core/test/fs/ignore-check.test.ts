import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIgnoredPaths } from '../../src/fs/ignore-check.js';

const PATHS = ['.gotchea/config.json', '.gotchea/questions/', 'src/a.ts'];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotchea-ignore-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('findIgnoredPaths without git', () => {
  const check = (paths = PATHS) => findIgnoredPaths(root, paths, { useGit: false });

  it('returns nothing without a .gitignore', async () => {
    expect(await check()).toEqual([]);
    expect(await check([])).toEqual([]);
  });

  it('reports the matching rule of the root .gitignore', async () => {
    await writeFile(join(root, '.gitignore'), '# state\nnode_modules/\n.gotchea/\n');
    expect(await check()).toEqual([
      { path: '.gotchea/config.json', source: '.gitignore', line: 3, pattern: '.gotchea/' },
      { path: '.gotchea/questions/', source: '.gitignore', line: 3, pattern: '.gotchea/' },
    ]);
  });

  it('lets a later negation re-include a path and reads .git/info/exclude', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await writeFile(join(root, '.git', 'info', 'exclude'), '*.ts\n');
    await writeFile(join(root, '.gitignore'), '.gotchea/*\n!.gotchea/config.json\n');
    expect(await check()).toEqual([
      { path: '.gotchea/questions/', source: '.gitignore', line: 1, pattern: '.gotchea/*' },
      { path: 'src/a.ts', source: '.git/info/exclude', line: 1, pattern: '*.ts' },
    ]);
  });
});

describe.runIf(hasGit())('findIgnoredPaths with git', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: root });
  });

  it('uses git check-ignore and skips negated matches', async () => {
    await writeFile(join(root, '.gitignore'), '.gotchea/*\n!.gotchea/config.json\n');
    const out = await findIgnoredPaths(root, PATHS);
    expect(out).toEqual([{ path: '.gotchea/questions/', source: '.gitignore', line: 1, pattern: '.gotchea/*' }]);
  });

  it('returns nothing when no rule matches', async () => {
    expect(await findIgnoredPaths(root, PATHS)).toEqual([]);
  });

  it('falls back to the .gitignore files outside a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'gotchea-ignore-plain-'));
    try {
      await writeFile(join(plain, '.gitignore'), '.gotchea\n');
      const out = await findIgnoredPaths(plain, ['.gotchea/config.json']);
      expect(out).toEqual([{ path: '.gotchea/config.json', source: '.gitignore', line: 1, pattern: '.gotchea' }]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
