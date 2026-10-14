import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRepoId, detectRemoteUrl, normalizeRemoteUrl, repoIdFromString } from '../../src/store/repo-id.js';

describe('normalizeRemoteUrl', () => {
  it.each([
    ['git@github.com:Owner/Repo.git', 'github.com/Owner/Repo'],
    ['git@GitHub.com:Owner/Repo', 'github.com/Owner/Repo'],
    ['github.com:Owner/Repo.git', 'github.com/Owner/Repo'],
    ['https://github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['https://user:tok@GitHub.com/Owner/Repo', 'github.com/Owner/Repo'],
    ['https://tok@github.com/Owner/Repo/', 'github.com/Owner/Repo'],
    ['http://github.com/Owner/Repo.git/', 'github.com/Owner/Repo'],
    ['ssh://git@github.com:22/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['ssh://git@github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['git+ssh://git@github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['ssh://git@github.com:Owner/Repo.git', 'github.com/Owner/Repo'],
    ['git://github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['HTTPS://GITLAB.example.COM/Group/Sub/Proj.git', 'gitlab.example.com/Group/Sub/Proj'],
    ['https://gitlab.example.com:8443/g/p.git', 'gitlab.example.com:8443/g/p'],
    ['  git@github.com:Owner/Repo.git\n', 'github.com/Owner/Repo'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it('gives the same id for ssh and https clones', () => {
    const a = repoIdFromString(normalizeRemoteUrl('git@github.com:Futuretea-LTD/gotchea.git'));
    const b = repoIdFromString(normalizeRemoteUrl('https://github.com/Futuretea-LTD/gotchea'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps path case (forks/owners stay distinct)', () => {
    expect(normalizeRemoteUrl('git@github.com:owner/repo.git')).not.toBe(normalizeRemoteUrl('git@github.com:Owner/Repo.git'));
  });
});

describe('computeRepoId', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotchea-repoid-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });

  it('falls back to the real path when not a git repo', async () => {
    expect(await detectRemoteUrl(dir)).toBeNull();
    const real = (await realpath(dir)).replace(/\\/g, '/');
    expect(await computeRepoId(dir)).toBe(repoIdFromString(real));
  });

  it('falls back to the path for a git repo without remotes', async () => {
    git('init', '-q');
    expect(await detectRemoteUrl(dir)).toBeNull();
    expect(await computeRepoId(dir)).toBe(repoIdFromString((await realpath(dir)).replace(/\\/g, '/')));
  });

  it('uses origin when present', async () => {
    git('init', '-q');
    git('remote', 'add', 'upstream', 'https://github.com/Other/Thing.git');
    git('remote', 'add', 'origin', 'git@github.com:Owner/Repo.git');
    expect(await detectRemoteUrl(dir)).toBe('git@github.com:Owner/Repo.git');
    expect(await computeRepoId(dir)).toBe(repoIdFromString('github.com/Owner/Repo'));
    expect(await computeRepoId(dir)).toBe(repoIdFromString(normalizeRemoteUrl('https://x:y@github.com/Owner/Repo')));
  });

  it('uses the first remote when there is no origin', async () => {
    git('init', '-q');
    git('remote', 'add', 'upstream', 'https://github.com/Other/Thing.git');
    expect(await computeRepoId(dir)).toBe(repoIdFromString('github.com/Other/Thing'));
  });
});
