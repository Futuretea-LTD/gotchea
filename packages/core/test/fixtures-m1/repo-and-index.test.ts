// repoId (git remote / no remote), personal-state location, and the
// file + line → chunk index answering on a fixture.
import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ChunkIndex } from '../../src/index/chunk-index.js';
import type { ChunksFile } from '../../src/model/chunk.js';
import { scanRepo } from '../../src/scan/scan.js';
import { repoPaths, userPaths } from '../../src/store/paths.js';
import { computeRepoId, repoIdFromString } from '../../src/store/repo-id.js';
import { copyFixture, type FixtureName, type FixtureRepo } from '../helpers/fixture-repo.js';

const exec = promisify(execFile);
const git = (root: string, ...args: string[]) => exec('git', ['-C', root, ...args]);

const repos: FixtureRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});
async function fixture(name: FixtureName): Promise<FixtureRepo> {
  const f = await copyFixture(name);
  repos.push(f);
  return f;
}

/** Every path under `dir`, relative, recursively. */
async function listAll(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${e.name}`;
    out.push(rel);
    if (e.isDirectory()) out.push(...(await listAll(join(dir, e.name), `${rel}/`)));
  }
  return out;
}

describe('repoId', () => {
  it('hashes the normalized origin URL, identical for SSH and HTTPS remotes', async () => {
    const a = await fixture('ts-basic');
    const b = await fixture('ts-basic');
    await git(a.root, 'init', '-q');
    await git(a.root, 'remote', 'add', 'origin', 'git@github.com:Futuretea-LTD/ts-basic.git');
    await git(b.root, 'init', '-q');
    await git(b.root, 'remote', 'add', 'origin', 'https://user:token@GitHub.com/Futuretea-LTD/ts-basic');
    const expected = repoIdFromString('github.com/Futuretea-LTD/ts-basic');
    expect(await computeRepoId(a.root)).toBe(expected);
    expect(await computeRepoId(b.root)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to the first remote when there is no origin', async () => {
    const f = await fixture('py-basic');
    await git(f.root, 'init', '-q');
    await git(f.root, 'remote', 'add', 'upstream', 'ssh://git@gitlab.example.com:2222/team/py-basic.git');
    expect(await computeRepoId(f.root)).toBe(repoIdFromString('gitlab.example.com/team/py-basic'));
  });

  it('without a remote (plain dir or git repo) hashes the real path, so two checkouts differ', async () => {
    const a = await fixture('ts-basic');
    const b = await fixture('ts-basic');
    await git(b.root, 'init', '-q');
    expect(await computeRepoId(a.root)).toBe(repoIdFromString(await realpath(a.root)));
    expect(await computeRepoId(b.root)).toBe(repoIdFromString(await realpath(b.root)));
    expect(await computeRepoId(a.root)).not.toBe(await computeRepoId(b.root));
    // Stable across calls.
    expect(await computeRepoId(a.root)).toBe(await computeRepoId(a.root));
  });
});

describe('personal state location', () => {
  it.each(['ts-basic', 'py-basic'] as const)('%s: progress and snapshots go under GOTCHEA_HOME/repos/<repoId>, never inside the repo', async (name) => {
    const f = await fixture(name);
    const repoId = await computeRepoId(f.root);
    // No `repoId` / stores passed: scanRepo derives everything like the CLI does.
    await scanRepo({ root: f.root, useGit: false, env: f.env });

    const user = userPaths(repoId, f.env);
    expect(user.repoDir).toBe(join(f.home, 'repos', repoId));
    expect((await stat(user.progress)).isFile()).toBe(true);
    const progress = JSON.parse(await readFile(user.progress, 'utf8')) as { version: number; repoId: string };
    expect(progress).toMatchObject({ version: 1, repoId });
    expect((await readdir(user.snapshotsDir)).length).toBeGreaterThan(0);

    // The repo only gains shared state: .gotchea/chunks.json.
    const inRepo = await listAll(f.root);
    expect(inRepo.filter((p) => /progress|snapshot|session/i.test(p))).toEqual([]);
    expect(inRepo.filter((p) => p.startsWith('.gotchea'))).toEqual(['.gotchea', '.gotchea/chunks.json']);
    expect((await stat(repoPaths(f.root).chunks)).isFile()).toBe(true);
  });
});

describe('ChunkIndex on a scanned fixture', () => {
  it('answers file + line lookups correctly and fast (cold load + build + lookups < 100 ms)', async () => {
    const f = await fixture('ts-basic');
    await scanRepo({ root: f.root, repoId: 'index', useGit: false, env: f.env });
    const text = await f.read('src/util/strings.ts');
    const engine = await f.read('src/services/report-engine.ts');
    const lineOf = (src: string, needle: string) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

    const t0 = performance.now();
    const file = JSON.parse(await readFile(repoPaths(f.root).chunks, 'utf8')) as ChunksFile;
    const index = new ChunkIndex(file.chunks);
    const at = (path: string, line: number) => index.lookup(path, line)?.id;
    const answers = {
      slug: at('src/util/strings.ts', lineOf(text, "return 'untitled';")),
      wrap: at('src/util/strings.ts', lineOf(text, 'lines.push(current);')),
      top: at('src/util/strings.ts', lineOf(text, "import { clamp } from './math.js';")),
      addRow: at('src/services/report-engine.ts', lineOf(engine, "throw new Error('report is frozen');")),
      body: at('src/services/report-engine.ts', lineOf(engine, 'private frozen = false;')),
      ctorGroup: at('src/services/report-engine.ts', lineOf(engine, 'return this.frozen;')),
      smallFile: at('src/util/math.ts', 5),
      windowsPath: at('src\\util\\math.ts', 5),
      missing: at('src/nope.ts', 1),
    };
    const elapsed = performance.now() - t0;

    expect(answers).toEqual({
      slug: 'src/util/strings.ts#~group:slugify',
      wrap: 'src/util/strings.ts#wordWrap',
      top: 'src/util/strings.ts#~top',
      addRow: 'src/services/report-engine.ts#ReportEngine.addRow',
      body: 'src/services/report-engine.ts#ReportEngine.~body',
      ctorGroup: 'src/services/report-engine.ts#ReportEngine.~group:constructor',
      smallFile: 'src/util/math.ts',
      windowsPath: 'src/util/math.ts',
      missing: undefined,
    });
    // Loose bound: PLAN.md §7 promises < 100 ms end to end; in-process this is ~1 ms.
    expect(elapsed).toBeLessThan(100);

    // Every leaf answers for each of its own lines.
    for (const leaf of file.chunks.filter((c) => c.isLeaf && c.kind !== 'file')) {
      for (const r of leaf.ranges) {
        expect(index.lookup(r.path, r.start)?.id, `${leaf.id}@${r.start}`).toBe(leaf.id);
        expect(index.lookup(r.path, r.end)?.id, `${leaf.id}@${r.end}`).toBe(leaf.id);
      }
    }
  });
});
