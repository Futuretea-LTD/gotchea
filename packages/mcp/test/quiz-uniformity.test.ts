// The correct option's display position must be uniform whatever the stored answer key looks like
// (PLAN.md §6, M3_DESIGN.md §10.2). Sessions are generated through the real `startQuiz`, with a
// seeded RNG (deterministic, never flaky) and with the default crypto RNG (generous bound).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsSessionStore, InMemorySessionStore, QuizSessions, computeRepoId, defaultConfig, seededRng, startQuiz, type Rng } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { NOW, createFixture, type Fixture } from './helpers.js';

const LEAF = 'src/math.ts';
const POOL = 20;
const SIZE = 5;

/** Pearson chi-square against a uniform expectation. */
const chiSquare = (counts: readonly number[]): number => {
  const n = counts.reduce((a, b) => a + b, 0);
  const e = n / counts.length;
  return counts.reduce((s, o) => s + (o - e) ** 2 / e, 0);
};

let fx: Fixture;
beforeEach(async () => {
  fx = await createFixture();
});
afterEach(() => fx.cleanup());

async function seed(keyOf: (i: number) => 0 | 1 | 2 | 3): Promise<QuestionPrivate[]> {
  const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((c) => c.id === LEAF)!;
  const qs: QuestionPrivate[] = Array.from({ length: POOL }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: leaf.id,
    chunkHash: leaf.contentHash,
    chunkLines: 4,
    type: 'behavior',
    stem: `UNI-STEM-${i}?`,
    options: [`u${i}-0`, `u${i}-1`, `u${i}-2`, `u${i}-3`],
    correctIndex: keyOf(i),
    explanation: `UNI-EXPL-${i}`,
    refs: [],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(fx.root).save(leaf.id, qs);
  return qs;
}

/** Display slots of the correct option over `sessions` quizzes, from the session permutation AND from the public view. */
async function sample(sessions: number, rng: Rng, pool: QuestionPrivate[]): Promise<{ fromPerm: number[]; fromView: number[] }> {
  const config = defaultConfig();
  const store = new InMemorySessionStore();
  const qs = new QuizSessions({ store, ttlMs: 3_600_000, retentionMs: 3_600_000, rng, now: () => NOW });
  const deps = { sessions: qs, origin: 'mcp' as const, config, env: fx.env, now: () => NOW, rng };
  const byId = new Map(pool.map((q) => [q.id, q]));
  const fromPerm = [0, 0, 0, 0];
  const fromView = [0, 0, 0, 0];
  for (let s = 0; s < sessions; s++) {
    // An untouched session is replaced by the next call, so the store stays at one session.
    const res = await startQuiz(fx.root, { chunkId: LEAF, count: SIZE }, deps);
    if (res.status === 'refused') throw new Error(res.message);
    const [session] = await qs.findActive({ origin: 'mcp' });
    for (const id of session!.questionIds) fromPerm[session!.permutations[id]!.indexOf(byId.get(id)!.correctIndex)]!++;
    const q = res.question;
    const right = byId.get(q.questionId)!.options[byId.get(q.questionId)!.correctIndex];
    fromView[q.options.find((o) => o.text === right)!.index]!++;
  }
  return { fromPerm, fromView };
}

/** Cheap path: permutations straight from `QuizSessions.create` (no disk, no scoring), for large samples. */
async function sampleCreate(sessions: number, rng: Rng, pool: QuestionPrivate[]): Promise<number[]> {
  const qs = new QuizSessions({ store: new InMemorySessionStore(), ttlMs: 3_600_000, retentionMs: 3_600_000, rng, now: () => NOW });
  const counts = [0, 0, 0, 0];
  for (let s = 0; s < sessions; s++) {
    const ids = pool.slice(0, SIZE).map((q) => q.id);
    const session = await qs.create({ origin: 'mcp', chunkId: LEAF, chunkHash: 'h', lang: 'en', questionIds: ids });
    for (const q of pool.slice(0, SIZE)) counts[session.permutations[q.id]!.indexOf(q.correctIndex)]!++;
  }
  return counts;
}

describe('correct display index is uniform for any key distribution (seeded RNG)', () => {
  const skews: [string, (i: number) => 0 | 1 | 2 | 3][] = [
    ['all keys 0', () => 0],
    ['all keys 3', () => 3],
    ['heavy skew toward 1', (i) => (i % 10 === 0 ? 2 : 1)],
    ['balanced keys', (i) => (i % 4) as 0 | 1 | 2 | 3],
  ];
  it.each(skews)('%s', async (_label, keyOf) => {
    const pool = await seed(keyOf);
    // Through the real startQuiz: 80 sessions (3 questions each: the leaf's size); χ²(3) < 16.27 is p = 0.001 and the seed is fixed.
    const { fromPerm, fromView } = await sample(80, seededRng(0xc0ffee), pool);
    expect(fromPerm.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(80 * 3);
    expect(chiSquare(fromPerm)).toBeLessThan(16.27);
    // First question as the client sees it (the real leak surface): uniform too (only 80 samples: p = 1e-4 bound).
    expect(fromView.reduce((a, b) => a + b, 0)).toBe(80);
    expect(chiSquare(fromView)).toBeLessThan(25);
    // Large sample of permutations: every slot within 25% ± 2%.
    const big = await sampleCreate(6_000, seededRng(0xc0ffee), pool);
    expect(chiSquare(big)).toBeLessThan(16.27);
    for (const c of big) expect(Math.abs(c / (6_000 * SIZE) - 0.25)).toBeLessThan(0.02);
  }, 60_000);
});

describe('default RNG', () => {
  it('is uniform over many generated sessions (loose bound: p ≈ 1e-6)', async () => {
    const pool = await seed(() => 0);
    const { fromPerm, fromView } = await sample(80, { int: (n) => Math.floor(Math.random() * n) }, pool);
    expect(chiSquare(fromPerm)).toBeLessThan(30);
    expect(chiSquare(fromView)).toBeLessThan(30);
    expect(chiSquare(await sampleCreate(4_000, { int: (n) => Math.floor(Math.random() * n) }, pool))).toBeLessThan(30);
  }, 60_000);

  it('cryptoRng, as used when no rng is injected, also spreads across all four slots', async () => {
    const { cryptoRng } = await import('gotchea-core');
    const pool = await seed(() => 2);
    const { fromPerm } = await sample(80, cryptoRng, pool);
    expect(chiSquare(fromPerm)).toBeLessThan(30);
    const big = await sampleCreate(4_000, cryptoRng, pool);
    expect(chiSquare(big)).toBeLessThan(30);
    expect(Math.min(...big)).toBeGreaterThan(0);
  }, 60_000);

  it('a session persisted by the Fs store keeps the same permutation after reload', async () => {
    const pool = await seed(() => 0);
    const repoId = await computeRepoId(fx.root);
    const store = new FsSessionStore(repoId, fx.env);
    const a = new QuizSessions({ store, ttlMs: 3_600_000, retentionMs: 3_600_000, rng: seededRng(5), now: () => NOW });
    const res = await startQuiz(fx.root, { chunkId: LEAF }, { sessions: a, origin: 'mcp', config: defaultConfig(), env: fx.env, now: () => NOW, rng: seededRng(5) });
    if (res.status === 'refused') throw new Error(res.message);
    const [live] = await a.findActive({ origin: 'mcp' });
    const b = new QuizSessions({ store: new FsSessionStore(repoId, fx.env), ttlMs: 3_600_000, retentionMs: 3_600_000, now: () => NOW });
    expect((await b.get(live!.id))?.permutations).toEqual(live!.permutations);
    expect(pool.length).toBe(POOL);
  });
});
