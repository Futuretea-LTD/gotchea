// Session crash recovery (M3_DESIGN.md §10.4): sessions survive a dropped in-memory store, a crash between
// scoring and the completion mark, torn files and a restarted MCP server, and progress is scored exactly once.
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsChunkStore,
  FsProgressStore,
  FsSessionStore,
  QuizSessions,
  chunkLineCount,
  computeRepoId,
  defaultConfig,
  runScan,
  seededRng,
  startQuiz,
  submitAnswer,
  userPaths,
  type QuizOpsDeps,
  type Session,
  type SessionStore,
  type SubmitAnswerResult,
} from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { NOW, connect, createFixture, type Fixture } from './helpers.js';

const CHUNK = 'src/big.ts#alpha';
const config = defaultConfig();

let fx: Fixture;
let repoId: string;
let clock: { t: number };

beforeEach(async () => {
  fx = await createFixture();
  repoId = await computeRepoId(fx.root);
  clock = { t: NOW.getTime() };
  const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((c) => c.id === CHUNK)!;
  const qs: QuestionPrivate[] = Array.from({ length: 8 }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: CHUNK,
    chunkHash: leaf.contentHash,
    chunkLines: chunkLineCount(leaf),
    type: 'behavior',
    stem: `REC-STEM-${i}?`,
    options: [`r${i}-a`, `r${i}-correct`, `r${i}-b`, `r${i}-c`],
    correctIndex: 1,
    explanation: `REC-EXPL-${i}`,
    refs: [{ start: 2, end: 3 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(fx.root).save(CHUNK, qs);
});
afterEach(() => fx.cleanup());

const now = () => new Date(clock.t);
/** A fresh "process": new store object, new manager, empty cache. */
const manager = (store: SessionStore = new FsSessionStore(repoId, fx.env), seed = 1): { deps: QuizOpsDeps; sessions: QuizSessions; store: SessionStore } => {
  const rng = seededRng(seed);
  const sessions = QuizSessions.fromConfig(store, config.quiz, { now, rng, cache: true });
  return { deps: { sessions, origin: 'mcp', config, env: fx.env, now, rng }, sessions, store };
};
const right = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => o.text.endsWith('-correct'))!.index;
const progress = async () => (await new FsProgressStore(repoId, fx.env).load()).chunks[CHUNK];
const sessionsDir = () => userPaths(repoId, fx.env).sessionsDir;

async function begin(deps: QuizOpsDeps) {
  const res = await startQuiz(fx.root, { chunkId: CHUNK, count: 5 }, deps);
  if (res.status === 'refused') throw new Error(res.message);
  return res;
}
const answer = async (deps: QuizOpsDeps, sessionId: string, q: { questionId: string; options: { index: number; text: string }[] }, idx = right(q)) =>
  submitAnswer(fx.root, { sessionId, questionId: q.questionId, displayIndex: idx }, deps);

describe('restart mid-session', () => {
  it('drops the in-memory store after 2 answers, reloads from sessions/, finishes, and scores exactly once', async () => {
    const a = manager();
    const started = await begin(a.deps);
    const total = started.session.total;
    expect(total).toBeGreaterThanOrEqual(3);
    const sid = started.session.id;
    let q = started.question;
    const r1 = await answer(a.deps, sid, q);
    expect(r1.status).toBe('answered');
    q = (r1 as Extract<SubmitAnswerResult, { status: 'answered' }>).next;
    const r2 = await answer(a.deps, sid, q);
    q = (r2 as Extract<SubmitAnswerResult, { status: 'answered' }>).next;
    const shownByA = q;

    // "Crash": nothing of A survives except the files.
    const onDisk = JSON.parse(await readFile(join(sessionsDir(), `${sid}.json`), 'utf8')) as Session;
    expect(Object.keys(onDisk.answers)).toHaveLength(2);

    const b = manager(new FsSessionStore(repoId, fx.env), 99); // different RNG seed: the permutation must come from disk
    const resumed = await startQuiz(fx.root, { chunkId: CHUNK }, b.deps);
    if (resumed.status === 'refused') throw new Error(resumed.message);
    expect(resumed.status).toBe('resumed');
    expect(resumed.session.id).toBe(sid);
    expect(resumed.session.answered).toBe(2);
    // The options of question 3 are exactly what A showed (permutation persisted, not redrawn).
    expect(resumed.question).toEqual(shownByA);

    let last: SubmitAnswerResult = await answer(b.deps, sid, resumed.question);
    while (last.status === 'answered') last = await answer(b.deps, sid, last.next);
    expect(last.status).toBe('completed');
    if (last.status !== 'completed') return;
    expect(last.result).toMatchObject({ passed: true, correct: total, total, before: { color: 'red' }, after: { color: 'green', R: 1 } });
    const p = (await progress())!;
    expect(p.history).toHaveLength(1);
    expect(p.history[0]).toMatchObject({ sessionId: sid, correct: total, total });
    expect(p.stability).toBe(config.score.initialStability);
    // The recovered session is now completed on disk too.
    expect(((await new FsSessionStore(repoId, fx.env).get(sid)) as Session).status).toBe('completed');
  });

  it('answers are idempotent across a restart: resending an answer already on disk returns repeat, not a second record', async () => {
    const a = manager();
    const s = await begin(a.deps);
    const first = await answer(a.deps, s.session.id, s.question);
    const b = manager(new FsSessionStore(repoId, fx.env));
    const again = await answer(b.deps, s.session.id, s.question);
    expect(again).toMatchObject({ status: 'answered', repeat: true });
    expect((again as Extract<SubmitAnswerResult, { status: 'answered' }>).next).toEqual((first as Extract<SubmitAnswerResult, { status: 'answered' }>).next);
    const wrongResend = await answer(b.deps, s.session.id, s.question, (right(s.question) + 1) % 4);
    expect(wrongResend).toMatchObject({ status: 'refused', reason: 'already_answered' });
  });
});

describe('crash between scoring and the completion mark', () => {
  it('a failed completion write leaves progress scored once; the resend gets the same result and S is not multiplied twice', async () => {
    const inner = new FsSessionStore(repoId, fx.env);
    let failures = 1;
    const flaky: SessionStore = {
      get: (id) => inner.get(id),
      put: async (s) => {
        if (s.status === 'completed' && failures-- > 0) throw new Error('disk full');
        await inner.put(s);
      },
      delete: (id) => inner.delete(id),
      list: () => inner.list(),
      purgeBroken: (t) => inner.purgeBroken(t),
    };
    const a = manager(flaky);
    const s = await begin(a.deps);
    let res: SubmitAnswerResult = await answer(a.deps, s.session.id, s.question);
    while (res.status === 'answered' && res.progress.answered < res.progress.total - 1) res = await answer(a.deps, s.session.id, res.next);
    const lastQ = (res as Extract<SubmitAnswerResult, { status: 'answered' }>).next;
    await expect(answer(a.deps, s.session.id, lastQ)).rejects.toThrow('disk full');

    // Progress was written before the crash.
    const afterCrash = (await progress())!;
    expect(afterCrash.history).toHaveLength(1);
    const S = afterCrash.stability;
    expect(S).toBe(config.score.initialStability);
    expect(((await inner.get(s.session.id)) as Session).status).toBe('active');

    // "Restart", resend the last answer.
    const b = manager(new FsSessionStore(repoId, fx.env));
    const retry = await answer(b.deps, s.session.id, lastQ);
    expect(retry).toMatchObject({ status: 'completed', repeat: true, result: { passed: true, after: { color: 'green', R: 1 } } });
    const p = (await progress())!;
    expect(p.history).toHaveLength(1);
    expect(p.stability).toBe(S);
    expect(((await inner.get(s.session.id)) as Session).status).toBe('completed');
    // And a third send is refused cleanly.
    expect(await answer(b.deps, s.session.id, lastQ)).toMatchObject({ status: 'refused', reason: 'session_completed' });
    expect((await progress())!.history).toHaveLength(1);
  });
});

describe('torn and corrupt session files', () => {
  it('startQuiz and sweep survive them, get() reads null, submit_answer says unknown_session, old debris is purged', async () => {
    await mkdir(sessionsDir(), { recursive: true });
    const tmp = join(sessionsDir(), 'qs_aaaaaaaaaaaaaaaa.json.123.tmp');
    const trunc = join(sessionsDir(), 'qs_bbbbbbbbbbbbbbbb.json');
    const alien = join(sessionsDir(), 'qs_cccccccccccccccc.json');
    await writeFile(tmp, '{"version":1,"id":"qs_aaaa');
    await writeFile(trunc, '{"version":1,"id":"qs_bbbbbbbbbbbbbbbb","orig');
    await writeFile(alien, JSON.stringify({ hello: 'world' }));

    const m = manager();
    const s = await begin(m.deps); // does not throw
    expect(await m.sessions.get('qs_bbbbbbbbbbbbbbbb')).toBeNull();
    expect(await m.sessions.get('qs_cccccccccccccccc')).toBeNull();
    const res = await answer(m.deps, 'qs_bbbbbbbbbbbbbbbb', s.question);
    expect(res).toMatchObject({ status: 'refused', reason: 'unknown_session' });
    expect(JSON.stringify(res)).not.toMatch(/REC-EXPL/);
    expect((await m.sessions.findActive({ origin: 'mcp' })).map((x) => x.id)).toEqual([s.session.id]);

    // Younger than an hour: kept (it may belong to a live writer).
    await m.sessions.sweep();
    expect((await readdir(sessionsDir())).sort()).toEqual(expect.arrayContaining(['qs_aaaaaaaaaaaaaaaa.json.123.tmp', 'qs_bbbbbbbbbbbbbbbb.json', 'qs_cccccccccccccccc.json']));

    // Older than an hour: removed, and the live session stays.
    const old = new Date(clock.t - 2 * 3_600_000);
    for (const f of [tmp, trunc, alien]) await utimes(f, old, old);
    const swept = await m.sessions.sweep();
    expect(swept.deleted).toBe(3);
    expect(await readdir(sessionsDir())).toEqual([`${s.session.id}.json`]);
  });

  it('a path-traversal session id never touches the filesystem outside sessions/', async () => {
    const m = manager();
    const s = await begin(m.deps);
    for (const bad of ['../../../etc/passwd', '..\\x', 'QS_AAAAAAAAAAAAAAAA', 'qs_short', '']) {
      expect(await answer(m.deps, bad, s.question)).toMatchObject({ status: 'refused', reason: 'unknown_session' });
    }
  });
});

describe('expiry, invalidation and retention', () => {
  it('an idle session expires after the TTL without touching progress; start_quiz then begins fresh', async () => {
    const m = manager();
    const s = await begin(m.deps);
    clock.t += (config.quiz.sessionTtlMinutes + 1) * 60_000;
    const res = await answer(m.deps, s.session.id, s.question);
    expect(res).toMatchObject({ status: 'refused', reason: 'session_expired' });
    expect(await progress()).toBeUndefined();
    const again = await begin(manager(new FsSessionStore(repoId, fx.env)).deps);
    expect(again.status).toBe('started');
    expect(again.session.id).not.toBe(s.session.id);
  });

  it('editing the chunk mid-session invalidates it (chunk_changed) and leaves progress alone', async () => {
    const m = manager();
    const s = await begin(m.deps);
    await answer(m.deps, s.session.id, s.question);
    const src = await readFile(join(fx.root, 'src/big.ts'), 'utf8');
    await writeFile(join(fx.root, 'src/big.ts'), src.replace('x += 0 * x;', 'x += 0 * x + 1;'));
    await runScan(fx.root, { env: fx.env });
    const next = (await submitAnswer(fx.root, { sessionId: s.session.id, questionId: s.question.questionId, displayIndex: 0 }, m.deps));
    // Already-recorded answers are repeats only while the chunk is unchanged; here the whole session is void.
    expect(next).toMatchObject({ status: 'refused', reason: 'chunk_changed' });
    expect(await progress()).toBeUndefined();
    expect(((await new FsSessionStore(repoId, fx.env).get(s.session.id)) as Session).status).toBe('expired');
  });

  it('retention: finished sessions older than sessionRetentionDays are deleted; younger and active ones stay', async () => {
    const m = manager();
    const done = await begin(m.deps);
    let r: SubmitAnswerResult = await answer(m.deps, done.session.id, done.question);
    while (r.status === 'answered') r = await answer(m.deps, done.session.id, r.next);
    expect(r.status).toBe('completed');
    clock.t += (config.quiz.sessionRetentionDays - 1) * 86_400_000;
    const live = await begin(m.deps);
    await m.sessions.sweep();
    const names = await readdir(sessionsDir());
    expect(names).toContain(`${done.session.id}.json`); // younger than the retention
    clock.t += 2 * 86_400_000 - 60_000 * (config.quiz.sessionTtlMinutes + 1);
    await m.sessions.sweep();
    const after = await readdir(sessionsDir());
    expect(after).not.toContain(`${done.session.id}.json`);
    expect(live.session.id.length).toBeGreaterThan(0);
  });

  it('start_quiz twice with no answers leaves exactly one active session; with an answer it resumes the same one', async () => {
    const m = manager();
    const first = await begin(m.deps);
    const second = await begin(m.deps);
    expect(second.status).toBe('started');
    expect(second.session.id).not.toBe(first.session.id);
    const active = await m.sessions.findActive({ origin: 'mcp' });
    expect(active.map((x) => x.id)).toEqual([second.session.id]);
    expect(((await m.store.get(first.session.id)) as Session).status).toBe('abandoned');
    await answer(m.deps, second.session.id, second.question);
    const third = await begin(m.deps);
    expect(third.status).toBe('resumed');
    expect(third.session.id).toBe(second.session.id);
  });
});

describe('MCP server restart', () => {
  it('a new server instance on the same storage continues the session, then finishes and scores once', async () => {
    const call = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) => (await c.client.callTool({ name, arguments: args })) as CallToolResult;
    const one = await connect(fx.root, fx.env, { rng: seededRng(4) });
    const start = (await call(one, 'start_quiz', { chunkId: CHUNK, count: 5 })).structuredContent as { session: { id: string; total: number }; question: { questionId: string; options: { index: number; text: string }[] } };
    let q = start.question;
    for (let n = 0; n < 2; n++) q = ((await call(one, 'submit_answer', { sessionId: start.session.id, questionId: q.questionId, displayIndex: right(q) })).structuredContent as { next: typeof q }).next;
    await one.close(); // server A is gone, memory and all

    const two = await connect(fx.root, fx.env, { rng: seededRng(77) });
    try {
      let out: { status: string; next?: typeof q } = { status: 'answered', next: q };
      while (out.status === 'answered') {
        const res = await call(two, 'submit_answer', { sessionId: start.session.id, questionId: out.next!.questionId, displayIndex: right(out.next!) });
        expect(res.isError).toBeFalsy();
        out = res.structuredContent as typeof out;
      }
      expect(out.status).toBe('completed');
      expect((await progress())!.history).toHaveLength(1);
    } finally {
      await two.close();
    }
  });
});
