// Re-scans of the fixture repos after edits: diff classification, changeRatio,
// stale questions, stability decay (with its floor) and red-after-rewrite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import type { Chunk } from '../../src/model/chunk.js';
import type { Progress } from '../../src/model/progress.js';
import type { QuestionPrivate } from '../../src/model/question.js';
import { scanRepo, type ScanResult } from '../../src/scan/scan.js';
import { chunkState } from '../../src/score/state.js';
import { computeTreeStates } from '../../src/score/aggregate.js';
import { FsProgressStore } from '../../src/store/progress-store.js';
import { FsQuestionStore } from '../../src/store/question-store.js';
import { copyFixture, type FixtureRepo } from '../helpers/fixture-repo.js';

const REPO_ID = 'rescan';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const cfg = defaultConfig().score;

let f: FixtureRepo;
let first: ScanResult;
const scan = () => scanRepo({ root: f.root, repoId: REPO_ID, useGit: false, env: f.env });
const chunk = (r: ScanResult, id: string): Chunk => {
  const c = r.chunks.find((x) => x.id === id);
  if (!c) throw new Error(`no chunk ${id}`);
  return c;
};

const question = (id: string, c: Pick<Chunk, 'id' | 'contentHash'>): QuestionPrivate => ({
  id,
  chunkId: c.id,
  chunkHash: c.contentHash,
  type: 'behavior',
  stem: `What does ${c.id} do? (${id})`,
  options: ['a', 'b', 'c', 'd'],
  correctIndex: 2,
  explanation: 'because',
  refs: [],
  difficulty: 2,
  lang: 'en',
  generatedBy: 'test',
  status: 'ok',
  flagged: false,
  chunkLines: 0,
  promptVersion: 'p1',
  verifiedBy: null,
  createdAt: NOW.toISOString(),
});

const passed = (hash: string, stability: number): Progress => ({
  stability,
  lastReviewedAt: NOW.toISOString(),
  lastPassedHash: hash,
  lastSeenHash: hash,
  mustRepass: false,
  history: [],
});

const STRINGS = 'src/util/strings.ts';
const WORD_WRAP = `${STRINGS}#wordWrap`; // 22 normalized LOC
const SLUG = `${STRINGS}#~group:slugify`;
const ENGINE = 'src/services/report-engine.ts';
const MERGE = `${ENGINE}#ReportEngine.merge`; // 18 normalized LOC

/** Replaces the text between two markers (start inclusive, end exclusive). */
async function replaceBetween(path: string, start: string, end: string, text: string): Promise<void> {
  const src = await f.read(path);
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  if (a < 0 || b <= a) throw new Error(`markers not found in ${path}`);
  await f.write(path, `${src.slice(0, a)}${text}${src.slice(b)}`);
}

/** wordWrap rewritten (new signature line too) but still >= mergeBelowLoc, so it keeps its id: only `}` survives. */
const rewriteWordWrap = () =>
  replaceBetween(
    STRINGS,
    'export function wordWrap(',
    'export function stripTags(',
    `export function wordWrap(text: string, columns: number): string[] {\n  const out: string[] = [];\n${Array.from({ length: 18 }, (_, i) => `  out.push(text.slice(${i} * columns, ${i + 1} * columns));`).join('\n')}\n  return out.filter(Boolean);\n}\n\n`,
  );

/** merge's body rewritten (signature kept, >= mergeBelowLoc): only the signature line and `}` survive. */
const rewriteMerge = () =>
  replaceBetween(
    ENGINE,
    '  merge(other: ReportEngine): number {',
    '  snapshot(): {',
    `  merge(other: ReportEngine): number {\n${Array.from({ length: 16 }, (_, i) => `    this.revision += other.size * ${i + 1};`).join('\n')}\n  }\n\n`,
  );

beforeEach(async () => {
  f = await copyFixture('ts-basic');
  first = await scan();
});
afterEach(async () => {
  await f.cleanup();
});

describe('scan diff classification', () => {
  it('classifies added / removed / changed / unchanged and the lists partition the chunk ids', async () => {
    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);'); // 1 line of wordWrap
    await f.write('src/util/extra.ts', 'export function extra(n: number): number {\n  return n * 2;\n}\n');
    await f.write('src/services/user-service.ts', ''); // emptied, still present
    await f.edit('src/util/math.ts', '  if (n > hi) return hi;\n', '  // upper bound\n  if (n > hi)   return hi;\n'); // comment + whitespace only
    const { rm } = await import('node:fs/promises');
    await rm(`${f.root}/src/models/user.ts`);

    const r = await scan();
    const { diff } = r;
    expect(diff.added).toEqual(['src/util/extra.ts']);
    expect(diff.removed).toEqual(['src/models', 'src/models/user.ts']);
    expect(diff.changed.map((c) => c.id)).toEqual(['.', 'src', 'src/services', 'src/services/user-service.ts', 'src/util', STRINGS, WORD_WRAP]);
    expect(diff.unchanged).toContain('src/util/math.ts');
    expect(diff.unchanged).toContain(SLUG);
    expect(diff.moved).toEqual([]);

    // Every current id is in exactly one of added/changed/unchanged; removed ids are gone.
    const now = r.chunks.map((c) => c.id).sort();
    const listed = [...diff.added, ...diff.changed.map((c) => c.id), ...diff.unchanged].sort();
    expect(listed).toEqual(now);
    for (const id of diff.removed) expect(now).not.toContain(id);
    expect(diff.removed.length + listed.length - diff.added.length).toBe(first.chunks.length);
  });

  it('reports a plausible changeRatio: changed lines / old LOC, capped at 1', async () => {
    // 1 of 22 lines in wordWrap.
    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);');
    // 5 inserted lines in merge (18 LOC) → 5/18.
    await f.edit(ENGINE, '    let merged = 0;\n', '    let merged = 0;\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    const d = 4;\n    void [a, b, c, d];\n');
    // Whole slugify group body replaced → ratio 1.
    const r0 = await f.read(STRINGS);
    const start = r0.indexOf('export function slugify(');
    const end = r0.indexOf('export function truncate(');
    await f.write(
      STRINGS,
      `${r0.slice(0, start)}${Array.from({ length: 5 }, (_, i) => `export function tiny${i}(x: number): number {\n  return x + ${i};\n}\n\n`).join('')}${r0.slice(end)}`,
    );

    const r = await scan();
    const ratio = (id: string) => r.diff.changed.find((c) => c.id === id)?.changeRatio;
    expect(ratio(WORD_WRAP)).toBeCloseTo(1 / 22, 10);
    expect(ratio(MERGE)).toBeCloseTo(5 / 18, 10);
    for (const c of r.diff.changed) {
      expect(c.changeRatio, c.id).toBeGreaterThan(0);
      expect(c.changeRatio, c.id).toBeLessThanOrEqual(1);
    }
    // The slugify group lost its anchor: removed, and the tiny functions form a new group.
    expect(r.diff.removed).toContain(SLUG);
    expect(r.diff.added).toContain(`${STRINGS}#~group:tiny0`);
  });

  it('detects a moved file (same content, new path) and carries its id as an alias', async () => {
    const { rename } = await import('node:fs/promises');
    await rename(`${f.root}/src/util/math.ts`, `${f.root}/src/util/numbers.ts`);
    // Keep importers resolving so the rest of the tree stays comparable.
    for (const p of ['src/util/strings.ts', 'src/services/user-service.ts', ENGINE]) {
      await f.write(p, (await f.read(p)).replace("from './math.js'", "from './numbers.js'").replace("from '../util/math.js'", "from '../util/numbers.js'"));
    }
    const r = await scan();
    expect(r.diff.moved).toEqual([{ from: 'src/util/math.ts', to: 'src/util/numbers.ts', kind: 'file', contentHash: chunk(first, 'src/util/math.ts').contentHash }]);
    expect(chunk(r, 'src/util/numbers.ts').aliases).toEqual(['src/util/math.ts']);
  });
});

describe('stale questions', () => {
  it('marks ok questions of changed chunks stale and leaves others alone', async () => {
    const questions = new FsQuestionStore(f.root);
    const ww = chunk(first, WORD_WRAP);
    const slug = chunk(first, SLUG);
    await questions.save(ww.id, [question('w1', ww), question('w2', ww), { ...question('w3', ww), status: 'stale' }]);
    await questions.save(slug.id, [question('s1', slug)]);

    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);');
    const r = await scan();

    expect(r.staleQuestions).toBe(2);
    const ww2 = await questions.list(ww.id);
    expect(ww2.map((q) => [q.id, q.status])).toEqual([
      ['w1', 'stale'],
      ['w2', 'stale'],
      ['w3', 'stale'], // already stale: not counted again
    ]);
    // chunkHash is kept: it records what the question was written against.
    expect(ww2.every((q) => q.chunkHash === ww.contentHash)).toBe(true);
    expect((await questions.list(slug.id))[0]!.status).toBe('ok');
  });

  it('keeps a question already written for the new hash ok', async () => {
    const questions = new FsQuestionStore(f.root);
    const ww = chunk(first, WORD_WRAP);
    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);');
    const preview = await scanRepo({ root: f.root, repoId: REPO_ID, useGit: false, env: f.env, dryRun: true });
    const fresh = chunk(preview, WORD_WRAP);
    await questions.save(ww.id, [question('old', ww), question('new', fresh)]);
    const r = await scan();
    expect(r.staleQuestions).toBe(1);
    expect(Object.fromEntries((await questions.list(ww.id)).map((q) => [q.id, q.status]))).toEqual({ old: 'stale', new: 'ok' });
  });

  it('deletes the question pool of a removed chunk', async () => {
    const questions = new FsQuestionStore(f.root);
    const user = chunk(first, 'src/models/user.ts');
    await questions.save(user.id, [question('u1', user)]);
    const { rm } = await import('node:fs/promises');
    await rm(`${f.root}/src/models/user.ts`);
    await scan();
    expect(await questions.list(user.id)).toEqual([]);
  });
});

describe('progress decay', () => {
  async function seed(entries: Record<string, Progress>): Promise<FsProgressStore> {
    const store = new FsProgressStore(REPO_ID, f.env);
    await store.save({ version: 1, repoId: REPO_ID, chunks: entries });
    return store;
  }

  it('decays S by (1 − changeRatio) on a small edit and keeps mustRepass off', async () => {
    const ww = chunk(first, WORD_WRAP);
    const store = await seed({ [ww.id]: passed(ww.contentHash, 20) });
    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);');
    const r = await scan();
    const p = (await store.load()).chunks[ww.id]!;
    expect(p.stability).toBeCloseTo(20 * (1 - 1 / 22), 10);
    expect(p.mustRepass).toBe(false);
    expect(p.lastSeenHash).toBe(chunk(r, WORD_WRAP).contentHash);
    expect(p.lastPassedHash).toBe(ww.contentHash); // passing is not implied by a change
    expect(r.decayed).toEqual([{ id: ww.id, fromHash: ww.contentHash, toHash: chunk(r, WORD_WRAP).contentHash, changeRatio: 1 / 22 }]);
    expect(r.reconciled).toEqual([]); // no double decay
  });

  it('applies the changeDecayFloor on a full rewrite, then the minStability clamp', async () => {
    const ww = chunk(first, WORD_WRAP);
    const merge = chunk(first, MERGE);
    const store = await seed({ [ww.id]: passed(ww.contentHash, 40), [merge.id]: passed(merge.contentHash, 5) });
    await rewriteWordWrap();
    await rewriteMerge();

    const r = await scan();
    const changes = new Map(r.diff.changed.map((c) => [c.id, c.changeRatio]));
    expect(changes.get(WORD_WRAP)).toBeCloseTo(21 / 22, 10); // 1 − ratio < floor
    expect(changes.get(MERGE)).toBeCloseTo(16 / 18, 10);
    const progress = (await store.load()).chunks;
    // S = max(minStability, S × max(floor, 1 − 21/22)) = max(1, 40 × 0.1) = 4.
    expect(progress[ww.id]!.stability).toBeCloseTo(40 * cfg.changeDecayFloor, 10);
    // max(1, 5 × max(0.1, 2/18)) = max(1, 0.56) = 1: clamped to minStability.
    expect(progress[merge.id]!.stability).toBe(cfg.minStability);
    expect(progress[ww.id]!.mustRepass).toBe(true);
    expect(progress[merge.id]!.mustRepass).toBe(true);
  });

  it('turns a changed leaf red when changeRatio > redOnChangeRatio, and keeps a lightly edited leaf green', async () => {
    const ww = chunk(first, WORD_WRAP);
    const merge = chunk(first, MERGE);
    const store = await seed({ [ww.id]: passed(ww.contentHash, 30), [merge.id]: passed(merge.contentHash, 30) });

    // wordWrap: 21 of 22 lines rewritten (> 0.5). merge: 1 of 18 lines (< 0.5).
    await rewriteWordWrap();
    await f.edit(ENGINE, '      merged++;', '      merged += 1;');

    const r = await scan();
    const ratio = (id: string) => r.diff.changed.find((c) => c.id === id)!.changeRatio;
    expect(ratio(WORD_WRAP)).toBeGreaterThan(cfg.redOnChangeRatio);
    expect(ratio(MERGE)).toBeLessThan(cfg.redOnChangeRatio);

    const progress = (await store.load()).chunks;
    expect(progress[ww.id]!.mustRepass).toBe(true);
    expect(progress[merge.id]!.mustRepass).toBe(false);
    // With freshly generated (ok) questions at the new hashes, at NOW (R ≈ 1):
    expect(chunkState(3, progress[ww.id], NOW, cfg).color).toBe('red');
    expect(chunkState(3, progress[merge.id], NOW, cfg).color).toBe('green');
    // Old questions went stale, so until regenerated the leaves are grey.
    const states = computeTreeStates({ chunks: r.chunks, okQuestions: new Map(), progress, now: NOW, cfg });
    expect(states.get(ww.id)!.color).toBe('grey');
  });

  it('decays progress the user last saw at an older hash once, via reconcile (e.g. after a pull)', async () => {
    const ww = chunk(first, WORD_WRAP);
    // Two edits, the user only "saw" the original.
    await f.edit(STRINGS, '  const limit = Math.max(1, width);', '  const limit = Math.max(2, width);');
    await scan();
    const store = await seed({ [ww.id]: passed(ww.contentHash, 20) });
    await f.edit(STRINGS, '  let current = \'\';', '  let current = \'-\';');
    const r = await scan();
    expect(r.decayed).toEqual([]); // diff old hash ≠ lastSeenHash
    expect(r.reconciled).toHaveLength(1);
    expect(r.reconciled[0]!.changeRatio).toBeCloseTo(2 / 22, 10); // against the user's snapshot
    expect((await store.load()).chunks[ww.id]!.stability).toBeCloseTo(20 * (1 - 2 / 22), 10);
  });
});
