import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsQuestionStore } from 'gotchea-core/internal';
import { FsChunkStore, FsProgressStore, computeRepoId, type Chunk } from 'gotchea-core';
import type { MapJson, MapNode } from '../src/program.js';
import { NOW, SentinelProvider, allKeys, answerDataIn, createSandbox, question, type Sandbox } from './helpers.js';

let s: Sandbox;

/** Small chunking thresholds so src/math.ts splits into symbols. */
async function initAndScan(): Promise<void> {
  await s.gotchea(['init']);
  await writeFile(join(s.root, '.gotchea', 'config.json'), JSON.stringify({ chunking: { leafMaxLoc: 10, leafMinLoc: 8, mergeBelowLoc: 6 } }));
  expect((await s.gotchea(['scan'])).code).toBe(0);
}

async function mapJson(...args: string[]): Promise<MapJson> {
  const r = await s.gotchea(['map', '--json', ...args]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as MapJson;
}

function flatten(node: MapNode): MapNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

const ids = (node: MapNode) => flatten(node).map((n) => n.id);

async function chunk(id: string): Promise<Chunk> {
  return (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === id)!;
}

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

describe('gotchea map', () => {
  it('fails helpfully before init and before the first scan', async () => {
    const before = await s.gotchea(['map']);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('gotchea init');
    await s.gotchea(['init']);
    const noScan = await s.gotchea(['map']);
    expect(noScan.code).toBe(1);
    expect(noScan.stderr).toContain('gotchea scan');
  });

  it('prints repo > module > file > symbol, all grey without questions', async () => {
    await initAndScan();
    const r = await s.gotchea(['map']);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    const name = s.root.slice(s.root.lastIndexOf('/') + 1);
    expect(lines[0]).toMatch(new RegExp(`^● ${name}/\\s+53 LOC\\s+–$`));
    expect(r.stdout).toMatch(/^├─ ● py\/\s+9 LOC\s+–$/m);
    expect(r.stdout).toMatch(/^ {3}└─ ● math\.ts\s+30 LOC\s+–$/m);
    expect(r.stdout).toMatch(/^ {6}└─ ● Stats\s+16 LOC\s+–$/m);
    expect(r.stdout).toContain('grey: no questions (6)');
    expect(r.stdout).not.toContain('\u001b[');
  });

  it('colors output unless --no-color', async () => {
    await initAndScan();
    expect((await s.gotchea(['map'], { color: true })).stdout).toContain('\u001b[');
    expect((await s.gotchea(['map', '--no-color'], { color: true })).stdout).not.toContain('\u001b[');
  });

  it('--json mirrors the tree with loc, metrics and state', async () => {
    await initAndScan();
    const out = await mapJson();
    expect(out).toMatchObject({ version: 1, repoId: await computeRepoId(s.root), filter: null, generatedAt: NOW.toISOString() });
    expect(ids(out.root)).toEqual([
      '.',
      'py',
      'py/app.py',
      'src',
      'src/format',
      'src/format/strings.ts',
      'src/index.ts',
      'src/math.ts',
      'src/math.ts#~group:clamp',
      'src/math.ts#mean',
      'src/math.ts#Stats',
    ]);
    for (const n of flatten(out.root)) expect(n.state).toEqual({ color: 'grey', R: null, dueAt: null });
    const stats = flatten(out.root).find((n) => n.id === 'src/math.ts#Stats')!;
    expect(stats).toMatchObject({ kind: 'symbol', path: 'src/math.ts', lines: { start: 19, end: 37 }, loc: 16, isLeaf: true, questionCount: 3 });
  });

  it('narrows the tree to a path or chunk id, keeping the ancestors', async () => {
    await initAndScan();
    expect(ids((await mapJson('src/math.ts')).root)).toEqual([
      '.',
      'src',
      'src/math.ts',
      'src/math.ts#~group:clamp',
      'src/math.ts#mean',
      'src/math.ts#Stats',
    ]);
    expect(ids((await mapJson('src/math.ts#Stats')).root)).toEqual(['.', 'src', 'src/math.ts', 'src/math.ts#Stats']);
    expect(ids((await mapJson('py')).root)).toEqual(['.', 'py', 'py/app.py']);
    expect(ids((await mapJson('./src/format/')).root)).toEqual(['.', 'src', 'src/format', 'src/format/strings.ts']);
    // A path prefix is not a match: `src/ma` is neither a directory nor a file.
    const none = await s.gotchea(['map', 'src/ma']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no chunks match src/ma');
    const outside = await s.gotchea(['map', '..']);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('outside the repository');
    expect((await s.gotchea(['map', '../../../etc/passwd'])).stderr).toContain('outside the repository');
    // A name that merely starts with `..` is inside the repo.
    expect((await s.gotchea(['map', '..foo'])).stderr).toContain('no chunks match ..foo');
  });

  it('accepts absolute paths through a symlinked checkout (real path vs. logical path)', async () => {
    await initAndScan();
    const real = await realpath(s.root);
    const viaReal = await s.gotchea(['map', '--json', join(real, 'py')]);
    expect(viaReal.code).toBe(0);
    const linkDir = await mkdtemp(join(tmpdir(), 'gotchea-cli-link-'));
    try {
      const link = join(linkDir, 'repo');
      // A junction on Windows (no privilege needed); the type is ignored elsewhere.
      await symlink(s.root, link, 'junction');
      const r = await s.gotchea(['map', '--json', join(link, 'py')], { cwd: s.root });
      expect(r.code).toBe(0);
      expect(ids((JSON.parse(r.stdout) as MapJson).root)).toEqual(['.', 'py', 'py/app.py']);
    } finally {
      await rm(linkDir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('colors leaves from questions and progress, aggregates parents and never leaks answers', async () => {
    await initAndScan();
    const stats = await chunk('src/math.ts#Stats');
    const mean = await chunk('src/math.ts#mean');
    const questions = new FsQuestionStore(s.root);
    await questions.save(stats.id, [question(stats.id, stats.contentHash)]);
    await questions.save(mean.id, [question(mean.id, mean.contentHash)]);
    const repoId = await computeRepoId(s.root);
    await new FsProgressStore(repoId, s.env).save({
      version: 1,
      repoId,
      chunks: {
        [stats.id]: {
          stability: 10,
          lastReviewedAt: NOW.toISOString(),
          lastPassedHash: stats.contentHash,
          lastSeenHash: stats.contentHash,
          mustRepass: false,
          history: [],
        },
      },
    });

    const out = await mapJson();
    const node = (id: string) => flatten(out.root).find((n) => n.id === id)!;
    expect(node(stats.id).state).toMatchObject({ color: 'green', R: 1 });
    expect(node(stats.id).okQuestions).toBe(1);
    // Questions but never passed: red with R = 0.
    expect(node(mean.id).state).toEqual({ color: 'red', R: 0, dueAt: null });
    // LOC-weighted: (16·1 + 4·0) / 20, grey siblings skipped.
    expect(node('src/math.ts').state).toMatchObject({ color: 'yellow', R: 0.8 });
    expect(node('src/index.ts').state.color).toBe('grey');

    const keys = allKeys(out);
    for (const leak of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) expect(keys.has(leak)).toBe(false);
    const text = (await s.gotchea(['map'])).stdout;
    expect(text).toMatch(/Stats\s+16 LOC\s+100%/);
    expect(text).toMatch(/math\.ts\s+30 LOC\s+80%/);
    expect(text).not.toContain('second guard');
  });

  it('after `generate`, generated leaves show their count and are no longer grey; nothing leaks', async () => {
    await initAndScan();
    const provider = new SentinelProvider();
    const gen = await s.gotchea(['generate', '--json', '--limit', '2'], { deps: provider.deps() });
    expect(gen.code, gen.stderr).toBe(0);
    const report = JSON.parse(gen.stdout) as { chunks: { chunkId: string; saved: number }[]; totals: { saved: number } };
    expect(report.totals.saved).toBeGreaterThan(0);
    expect(answerDataIn(gen.stdout + gen.stderr)).toEqual([]);
    for (const leak of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) expect(allKeys(report).has(leak)).toBe(false);

    const out = await mapJson();
    const node = (id: string) => flatten(out.root).find((n) => n.id === id)!;
    for (const c of report.chunks) {
      expect(node(c.chunkId).okQuestions, c.chunkId).toBe(c.saved);
      expect(node(c.chunkId).state, c.chunkId).toEqual({ color: 'red', R: 0, dueAt: null });
    }
    for (const leak of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) expect(allKeys(out).has(leak)).toBe(false);

    const text = await s.gotchea(['map']);
    const first = report.chunks[0]!;
    const title = flatten(out.root).find((n) => n.id === first.chunkId)!.title;
    expect(text.stdout).toMatch(new RegExp(`● ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+ LOC\\s+0% · ${first.saved} q$`, 'm'));
    expect(answerDataIn(text.stdout + JSON.stringify(out))).toEqual([]);
  });
});
