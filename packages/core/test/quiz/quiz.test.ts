import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { InMemoryProgressStore } from '../../src/store/progress-store.js';
import { FsSessionStore, InMemorySessionStore } from '../../src/store/session-store.js';
import { assertPublicView, PublicQuestionViewSchema, toPrivateView, toPublicView, toRevealView } from '../../src/quiz/views.js';
import { makePermutation, seededRng } from '../../src/quiz/rng.js';
import { QuizSelectError, selectChunk, selectQuestions, sessionSize } from '../../src/quiz/select.js';
import { QuizSessions, SessionError, SessionSchema, scoreSession } from '../../src/quiz/session.js';
import type { QuestionPrivate } from '../../src/model/question.js';
import type { SessionStore } from '../../src/store/types.js';

const cfg = defaultConfig();
const metrics = (fanIn: number) => ({ loc: 10, complexity: 1, fanIn });
const leaf = (id: string, fanIn = 0, questionCount = 3) => ({ id, isLeaf: true, metrics: metrics(fanIn), questionCount });

describe('selectChunk', () => {
  const chunks = [leaf('a.ts#a'), leaf('a.ts#b', 5), leaf('a.ts#c')];
  const usable = new Map([['a.ts#a', 3], ['a.ts#b', 3], ['a.ts#c', 3]]);
  const base = { chunks, usable, progress: {}, count: undefined, cfg: cfg.quiz };

  it('prefers low R and high fan-in, using the score priority', () => {
    const states = new Map([
      ['a.ts#a', { R: 0.2, color: 'red' as const }],
      ['a.ts#b', { R: 0.2, color: 'red' as const }],
      ['a.ts#c', { R: 0.9, color: 'green' as const }],
    ]);
    const r = selectChunk({ ...base, states, target: {} });
    expect(r.chunkId).toBe('a.ts#b');
    expect(r.allGreen).toBe(false);
  });

  it('mustRepass outranks a high-R chunk', () => {
    const states = new Map([
      ['a.ts#a', { R: 0.99, color: 'green' as const }],
      ['a.ts#b', { R: 0.5, color: 'yellow' as const }],
      ['a.ts#c', { R: 0.5, color: 'yellow' as const }],
    ]);
    expect(selectChunk({ ...base, states, target: { path: 'a.ts' }, progress: { 'a.ts#a': { mustRepass: true } } }).chunkId).toBe('a.ts#a');
  });

  it('reports typed errors', () => {
    const states = new Map();
    const code = (target: object) => {
      try {
        selectChunk({ ...base, states, target });
      } catch (e) {
        return (e as QuizSelectError).code;
      }
    };
    expect(code({ chunkId: 'nope' })).toBe('unknown_chunk');
    expect(code({ path: 'zzz' })).toBe('no_match');
    expect(code({ chunkId: 'a.ts#a', path: undefined })).toBeUndefined();
    expect(() => selectChunk({ ...base, states, usable: new Map(), target: { chunkId: 'a.ts#a' } })).toThrow(/needed/);
    expect(() => selectChunk({ ...base, states, usable: new Map(), target: {} })).toThrow(QuizSelectError);
  });

  it('clamps session size', () => {
    expect(sessionSize({ questionCount: 5 }, undefined, cfg.quiz)).toBe(5);
    expect(sessionSize({ questionCount: 5 }, 1, cfg.quiz)).toBe(3);
    expect(sessionSize({ questionCount: 5 }, 9, cfg.quiz)).toBe(5);
  });
});

const q = (id: string, correctIndex: 0 | 1 | 2 | 3 = 1, extra: Partial<QuestionPrivate> = {}): QuestionPrivate => ({
  id,
  chunkId: 'a.ts#a',
  chunkHash: 'h1',
  chunkLines: 4,
  type: 'behavior',
  stem: `STEM-${id}`,
  options: ['o0', 'o1', 'o2', 'o3'],
  correctIndex,
  explanation: `EXPL-${id}`,
  refs: [{ start: 2, end: 3 }],
  difficulty: 1,
  lang: 'en',
  generatedBy: 'host:test',
  promptVersion: 'p1',
  status: 'ok',
  flagged: false,
  verifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const ids = ['q_000000000001', 'q_000000000002', 'q_000000000003', 'q_000000000004'];

describe('selectQuestions', () => {
  const pool = ids.map((id) => q(id));
  it('is deterministic, excludes stale/flagged and prefers not recently asked', () => {
    const input = {
      pool: [...pool, q('q_000000000009', 0, { flagged: true }), q('q_00000000000a', 0, { chunkHash: 'old' })],
      chunkHash: 'h1',
      size: 3,
      lang: 'en',
      history: [{ questionIds: [ids[0]!, ids[1]!] }],
      excludeRecentSessions: 2,
    };
    const a = selectQuestions({ ...input, rng: seededRng(1) });
    expect(a).toEqual(selectQuestions({ ...input, rng: seededRng(1) }));
    expect(a).toHaveLength(3);
    expect(a).toContain(ids[2]);
    expect(a).toContain(ids[3]);
    expect(() => selectQuestions({ ...input, size: 5, rng: seededRng(1) })).toThrow(/needed/);
  });
});

describe('permutations', () => {
  it('are uniform over display slots whatever the key', () => {
    const rng = seededRng(7);
    const counts = [0, 0, 0, 0];
    const N = 20000;
    for (let i = 0; i < N; i++) counts[makePermutation(rng).indexOf(0)]!++;
    const chi = counts.reduce((s, o) => s + (o - N / 4) ** 2 / (N / 4), 0);
    expect(chi).toBeLessThan(16.27);
  });
  it('consults the injected RNG', () => {
    const calls: number[] = [];
    makePermutation({
      int: (n) => {
        calls.push(n);
        return 0;
      },
    });
    expect(calls).toEqual([4, 3, 2]);
  });
});

describe('views', () => {
  const perm: [number, number, number, number] = [3, 2, 1, 0];
  it('public view hides the key and rejects unknown keys', () => {
    const v = toPublicView(q(ids[0]!), perm, 1, 3);
    expect(Object.keys(v).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total']);
    expect(v.options.map((o) => o.text)).toEqual(['o3', 'o2', 'o1', 'o0']);
    expect(() => assertPublicView({ ...v, correctIndex: 1 })).toThrow();
    expect(() => assertPublicView({ ...v, options: v.options.map((o) => ({ ...o, explanation: 'x' })) })).toThrow();
    expect(() => PublicQuestionViewSchema.parse({ ...v, extra: 1 })).toThrow();
    expect(assertPublicView(v)).toEqual(v);
  });
  it('reveal maps display index to canonical option and refs to absolute lines', () => {
    const pv = toPrivateView(q(ids[0]!, 1), perm, 1, 3);
    expect(pv.correctDisplayIndex).toBe(2);
    const chunk = { ranges: [{ path: 'a.ts', start: 10, end: 11 }, { path: 'a.ts', start: 20, end: 21 }] };
    const r = toRevealView(pv, 2, chunk);
    expect(r).toMatchObject({ correct: true, correctText: 'o1', explanation: `EXPL-${ids[0]}` });
    expect(r.refs).toEqual([
      { path: 'a.ts', startLine: 11, endLine: 11, approximate: false },
      { path: 'a.ts', startLine: 20, endLine: 20, approximate: false },
    ]);
    expect(toRevealView(pv, 0, chunk).correct).toBe(false);
    expect(toRevealView(pv, 0, { ranges: [{ path: 'a.ts', start: 1, end: 9 }] }).refs[0]?.approximate).toBe(true);
  });
});

describe('sessions', () => {
  const make = (store: SessionStore = new InMemorySessionStore(), now = { t: Date.parse('2026-02-01T00:00:00Z') }) => ({
    store,
    now,
    sessions: new QuizSessions({ store, ttlMs: 60_000, retentionMs: 3_600_000, rng: seededRng(3), now: () => new Date(now.t) }),
  });
  const start = (s: QuizSessions) => s.create({ origin: 'cli', chunkId: 'a.ts#a', chunkHash: 'h1', lang: 'en', questionIds: ids.slice(0, 3) });

  it('maps displayIndex to the canonical option, in order, idempotently', async () => {
    const { sessions } = make();
    const s = await start(sessions);
    expect(SessionSchema.safeParse(s).success).toBe(true);
    const key = 1;
    const wrongSlot = (s.permutations[ids[0]!]!.indexOf(key) + 1) % 4;
    await expect(sessions.recordAnswer(s.id, ids[1]!, 0, () => true)).rejects.toMatchObject({ code: 'out_of_order' });
    const r = await sessions.recordAnswer(s.id, ids[0]!, s.permutations[ids[0]!]!.indexOf(key), (o) => o === key);
    expect(r.answer.correct).toBe(true);
    const again = await sessions.recordAnswer(s.id, ids[0]!, r.answer.displayIndex, () => false);
    expect(again.repeat).toBe(true);
    await expect(sessions.recordAnswer(s.id, ids[0]!, wrongSlot, () => true)).rejects.toBeInstanceOf(SessionError);
    await expect(sessions.recordAnswer(s.id, 'q_nope', 0, () => true)).rejects.toMatchObject({ code: 'unknown_question' });
    await expect(sessions.recordAnswer('qs_0000000000000000', ids[0]!, 0, () => true)).rejects.toMatchObject({ code: 'unknown_session' });
  });

  it('expires idle sessions and sweeps old ones', async () => {
    const { sessions, now } = make();
    const s = await start(sessions);
    now.t += 61_000;
    await expect(sessions.recordAnswer(s.id, ids[0]!, 0, () => true)).rejects.toMatchObject({ code: 'session_expired' });
    now.t += 4_000_000;
    expect(await sessions.sweep()).toMatchObject({ deleted: 1 });
    expect(await sessions.get(s.id)).toBeNull();
  });

  it('rejects a malformed id without touching the store', async () => {
    const calls: string[] = [];
    const store = new InMemorySessionStore();
    const spy: SessionStore = { ...store, put: store.put.bind(store), delete: store.delete.bind(store), list: store.list.bind(store), purgeBroken: store.purgeBroken.bind(store), get: async (id: string) => {
        calls.push(id);
        return null;
      },
    };
    const { sessions } = make(spy);
    expect(await sessions.get('../x')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('schema rejects extra keys, bad permutations and non-prefix answers', async () => {
    const { sessions } = make();
    const s = await start(sessions);
    expect(SessionSchema.safeParse({ ...s, correctIndex: 1 }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...s, permutations: { ...s.permutations, [ids[0]!]: [0, 0, 1, 2] } }).success).toBe(false);
    const ans = { displayIndex: 0, correct: true, answeredAt: s.startedAt };
    expect(SessionSchema.safeParse({ ...s, answers: { [ids[1]!]: ans } }).success).toBe(false);
  });

  it('persists atomically and survives a restart; corrupt files read as null', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gotchea-sess-'));
    const env = { GOTCHEA_HOME: home };
    const store = new FsSessionStore('repo1', env);
    const a = make(store).sessions;
    const s = await start(a);
    await a.recordAnswer(s.id, ids[0]!, 2, () => true);
    const b = make(new FsSessionStore('repo1', env)).sessions;
    const reloaded = await b.get(s.id);
    expect(reloaded?.permutations).toEqual(s.permutations);
    expect(Object.keys(reloaded!.answers)).toEqual([ids[0]]);
    const raw = await readFile(store.pathFor(s.id), 'utf8');
    expect(raw).not.toMatch(/correctIndex|STEM|EXPL/);
    await writeFile(join(store.dir, 'qs_aaaaaaaaaaaaaaaa.json'), '{not json');
    expect(await store.get('qs_aaaaaaaaaaaaaaaa')).toBeNull();
    expect((await store.list()).map((x) => x.id)).toEqual([s.id]);
    expect((await readdir(store.dir)).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('scores once, updating progress with the M2 transitions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gotchea-score-'));
    const { sessions } = make();
    let s = await start(sessions);
    for (const id of s.questionIds) ({ session: s } = await sessions.recordAnswer(s.id, id, 0, () => true));
    const progress = new InMemoryProgressStore('repo1');
    const opts = { repoId: 'repo1', config: cfg, progress, env: { GOTCHEA_HOME: home }, now: new Date('2026-02-01T00:00:00Z') };
    const first = await scoreSession(s, opts);
    expect(first).toMatchObject({ passed: true, correct: 3, needed: 3, alreadyScored: false });
    expect(first.after.stability).toBe(cfg.score.initialStability);
    const second = await scoreSession(s, opts);
    expect(second.alreadyScored).toBe(true);
    expect((await progress.load()).chunks['a.ts#a']?.history).toHaveLength(1);
  });
});
