import { now as currentTime } from '../now.js';
// Server-side quiz sessions (M3_DESIGN.md §3). A session holds the question order, one
// option permutation per question and the answers given; it never holds the answer key,
// a stem, an option or an explanation. Only a completed session scores (`scoreSession`).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GotcheaConfig } from '../config/schema.js';
import type { Progress } from '../model/progress.js';
import { passThreshold } from '../score/state.js';
import { onSessionResult } from '../score/transitions.js';
import { FsProgressStore } from '../store/progress-store.js';
import { withRepoLock, type RepoLockOptions } from '../store/repo-lock.js';
import type { ProgressStore, SessionStore } from '../store/types.js';
import { type Permutation, type Rng, cryptoRng, makePermutation } from './rng.js';

export { type Permutation, type Rng, cryptoRng, makePermutation, seededRng } from './rng.js';

export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'expired';
export type SessionOrigin = 'mcp' | 'cli';

export interface Answer {
  displayIndex: 0 | 1 | 2 | 3;
  correct: boolean;
  answeredAt: string;
}

export interface Session {
  version: 1;
  /** 'qs_' + 16 lowercase hex. */
  id: string;
  origin: SessionOrigin;
  chunkId: string;
  /** contentHash when the quiz started; a change ends the session. */
  chunkHash: string;
  lang: string;
  /** In presentation order. */
  questionIds: string[];
  /** questionId → `perm[displayIndex] = originalIndex`. */
  permutations: Record<string, Permutation>;
  /** questionId → answer. The answered ids are always a prefix of `questionIds`. */
  answers: Record<string, Answer>;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  completedAt?: string;
}

export const SESSION_ID = /^qs_[0-9a-f]{16}$/;

const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO date');
const Index = z.number().int().min(0).max(3);

const AnswerSchema = z.strictObject({ displayIndex: Index, correct: z.boolean(), answeredAt: Iso });

const PermutationSchema = z
  .tuple([Index, Index, Index, Index])
  .refine((p) => new Set(p).size === 4, 'permutation must be a bijection of [0, 1, 2, 3]');

/** Strict: a hand-edited file or a future writer can't smuggle `correctIndex` or text in. */
export const SessionSchema = z
  .strictObject({
    version: z.literal(1),
    id: z.string().regex(SESSION_ID),
    origin: z.enum(['mcp', 'cli']),
    chunkId: z.string().min(1),
    chunkHash: z.string().min(1),
    lang: z.string().min(1),
    questionIds: z.array(z.string().min(1)).min(1),
    permutations: z.record(z.string(), PermutationSchema),
    answers: z.record(z.string(), AnswerSchema),
    status: z.enum(['active', 'completed', 'abandoned', 'expired']),
    startedAt: Iso,
    lastActivityAt: Iso,
    expiresAt: Iso,
    completedAt: Iso.optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.questionIds.every((id) => s.permutations[id] !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'every question needs a permutation' });
    }
    const answered = s.questionIds.filter((id) => s.answers[id] !== undefined).length;
    const prefix = s.questionIds.slice(0, answered).every((id) => s.answers[id] !== undefined);
    if (!prefix || Object.keys(s.answers).length !== answered) ctx.addIssue({ code: 'custom', message: 'answers must be a prefix of questionIds' });
  });

export type SessionErrorCode =
  | 'unknown_session'
  | 'session_completed'
  | 'session_expired'
  | 'unknown_question'
  | 'already_answered'
  | 'out_of_order'
  | 'invalid_index';

export class SessionError extends Error {
  override readonly name = 'SessionError';

  constructor(
    readonly code: SessionErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export interface QuizSessionsOptions {
  store: SessionStore;
  now?: () => Date;
  rng?: Rng;
  ttlMs: number;
  retentionMs: number;
  /** Keep sessions in memory in front of the store (MCP server). */
  cache?: boolean;
}

/** An hour: stray `.tmp` and corrupt files younger than this may belong to a live writer. */
const BROKEN_GRACE_MS = 3_600_000;

export class QuizSessions {
  private readonly store: SessionStore;
  private readonly now: () => Date;
  private readonly rng: Rng;
  private readonly ttlMs: number;
  private readonly retentionMs: number;
  private readonly cache: Map<string, Session> | null;
  /** Per-session write chain: answers to one session are applied one at a time. */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(opts: QuizSessionsOptions) {
    this.store = opts.store;
    this.now = opts.now ?? currentTime;
    this.rng = opts.rng ?? cryptoRng;
    this.ttlMs = opts.ttlMs;
    this.retentionMs = opts.retentionMs;
    this.cache = opts.cache ? new Map() : null;
  }

  static fromConfig(store: SessionStore, quiz: Pick<GotcheaConfig['quiz'], 'sessionTtlMinutes' | 'sessionRetentionDays'>, opts: { now?: () => Date; rng?: Rng; cache?: boolean } = {}): QuizSessions {
    return new QuizSessions({ store, ttlMs: quiz.sessionTtlMinutes * 60_000, retentionMs: quiz.sessionRetentionDays * 86_400_000, ...opts });
  }

  /** Draws one independent permutation per question and persists before returning. */
  async create(i: { origin: SessionOrigin; chunkId: string; chunkHash: string; lang: string; questionIds: string[] }): Promise<Session> {
    const now = this.now();
    const permutations: Record<string, Permutation> = {};
    for (const id of i.questionIds) permutations[id] = makePermutation(this.rng);
    const session: Session = {
      version: 1,
      id: `qs_${randomBytes(8).toString('hex')}`,
      origin: i.origin,
      chunkId: i.chunkId,
      chunkHash: i.chunkHash,
      lang: i.lang,
      questionIds: [...i.questionIds],
      permutations,
      answers: {},
      status: 'active',
      startedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    await this.save(SessionSchema.parse(session) as Session);
    return session;
  }

  /** Applies lazy expiry; never throws on a missing, corrupt or malformed id. */
  async get(id: string): Promise<Session | null> {
    if (!SESSION_ID.test(id)) return null;
    const s = this.cache?.get(id) ?? (await this.store.get(id));
    if (!s) return null;
    if (s.status === 'active' && this.now().getTime() > Date.parse(s.expiresAt)) return this.save({ ...s, status: 'expired' });
    this.cache?.set(id, s);
    return s;
  }

  /** Active sessions of this origin, newest first. */
  async findActive(f: { origin: SessionOrigin; inChunks?: ReadonlySet<string> }): Promise<Session[]> {
    const out: Session[] = [];
    for (const raw of await this.store.list()) {
      const s = await this.get(raw.id);
      if (s && s.status === 'active' && s.origin === f.origin && (!f.inChunks || f.inChunks.has(s.chunkId))) out.push(s);
    }
    return out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || (a.id < b.id ? -1 : 1));
  }

  /**
   * Records the answer for `questionId` in order. `grade` receives the canonical option
   * index the displayed one maps to and is supplied by the caller, which holds the key.
   * A resend of the identical answer is idempotent (`repeat`).
   */
  recordAnswer(
    id: string,
    questionId: string,
    displayIndex: number,
    grade: (originalIndex: number) => boolean,
  ): Promise<{ session: Session; answer: Answer; repeat: boolean }> {
    return this.serial(id, async () => {
      if (!Number.isInteger(displayIndex) || displayIndex < 0 || displayIndex > 3) throw new SessionError('invalid_index', 'displayIndex must be 0-3');
      const s = await this.get(id);
      if (!s) throw new SessionError('unknown_session');
      if (s.status === 'expired') throw new SessionError('session_expired');
      if (s.status !== 'active') throw new SessionError('session_completed');
      const perm = s.permutations[questionId];
      if (!s.questionIds.includes(questionId) || !perm) throw new SessionError('unknown_question');
      const prev = s.answers[questionId];
      if (prev) {
        if (prev.displayIndex !== displayIndex) throw new SessionError('already_answered');
        return { session: s, answer: prev, repeat: true };
      }
      if (s.questionIds.find((q) => !s.answers[q]) !== questionId) throw new SessionError('out_of_order');
      const at = this.now();
      const answer: Answer = { displayIndex: displayIndex as Answer['displayIndex'], correct: grade(perm[displayIndex]!), answeredAt: at.toISOString() };
      const session = await this.save({
        ...s,
        answers: { ...s.answers, [questionId]: answer },
        lastActivityAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + this.ttlMs).toISOString(),
      });
      return { session, answer, repeat: false };
    });
  }

  markCompleted(id: string): Promise<Session> {
    return this.serial(id, async () => {
      const s = await this.get(id);
      if (!s) throw new SessionError('unknown_session');
      if (s.status === 'completed') return s;
      if (s.status !== 'active') throw new SessionError('session_expired');
      return this.save({ ...s, status: 'completed', completedAt: this.now().toISOString() });
    });
  }

  /** Marks an active session expired without scoring it (e.g. the chunk changed mid-quiz). No-op for other states. */
  expire(id: string): Promise<void> {
    return this.serial(id, async () => {
      const s = await this.get(id);
      if (s?.status === 'active') await this.save({ ...s, status: 'expired' });
    });
  }

  /** Server start: sweeps old sessions and loads the live ones into the cache. Returns how many are active. */
  async recover(): Promise<number> {
    await this.sweep();
    let active = 0;
    for (const s of await this.store.list()) if ((await this.get(s.id))?.status === 'active') active++;
    return active;
  }

  /** Ends an active session without scoring it. No-op for other states. */
  abandon(id: string): Promise<void> {
    return this.serial(id, async () => {
      const s = await this.get(id);
      if (s?.status === 'active') await this.save({ ...s, status: 'abandoned' });
    });
  }

  /** Expires idle sessions, deletes old finished ones and old corrupt or `.tmp` files. */
  async sweep(): Promise<{ expired: number; deleted: number }> {
    const now = this.now().getTime();
    let expired = 0;
    let deleted = 0;
    for (const s of await this.store.list()) {
      let cur: Session = s;
      if (cur.status === 'active' && now > Date.parse(cur.expiresAt)) {
        cur = await this.save({ ...cur, status: 'expired' });
        expired++;
      }
      if (cur.status !== 'active' && now - Date.parse(cur.lastActivityAt) > this.retentionMs) {
        await this.store.delete(cur.id);
        this.cache?.delete(cur.id);
        deleted++;
      }
    }
    deleted += await this.store.purgeBroken(now - BROKEN_GRACE_MS);
    return { expired, deleted };
  }

  private async save(s: Session): Promise<Session> {
    await this.store.put(s);
    this.cache?.set(s.id, s);
    return s;
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return next;
  }
}

export interface ScoreSessionOptions {
  repoId: string;
  config: Pick<GotcheaConfig, 'quiz' | 'score'>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Defaults to the Fs store for `repoId`. */
  progress?: ProgressStore;
  lock?: RepoLockOptions;
}

export interface ScoreOutcome {
  passed: boolean;
  correct: number;
  total: number;
  needed: number;
  before: Progress | undefined;
  after: Progress;
  /** The session was already in `progress.history` (a resend after a crash): nothing was written. */
  alreadyScored: boolean;
}

/**
 * Scores a fully answered session with the M2 transition (`onSessionResult`) under the
 * repo lock. Idempotent on the session id, so S is never multiplied twice.
 */
export async function scoreSession(session: Session, opts: ScoreSessionOptions): Promise<ScoreOutcome> {
  const answers = session.questionIds.map((q) => session.answers[q]);
  if (answers.some((a) => a === undefined)) throw new SessionError('out_of_order', 'session is not fully answered');
  const total = session.questionIds.length;
  const correct = answers.filter((a) => a!.correct).length;
  const needed = passThreshold(total, opts.config.quiz.passRatio);
  const passed = correct >= needed;
  const env = opts.env ?? process.env;
  const store = opts.progress ?? new FsProgressStore(opts.repoId, env);

  return withRepoLock(
    opts.repoId,
    async () => {
      const file = await store.load();
      const before = file.chunks[session.chunkId];
      const done = before?.history.some((h) => h.sessionId === session.id) ?? false;
      if (done) return { passed, correct, total, needed, before, after: before!, alreadyScored: true };
      const after = onSessionResult(
        before,
        {
          passed,
          at: (opts.now ?? currentTime(env)).toISOString(),
          hash: session.chunkHash,
          sessionId: session.id,
          questionIds: session.questionIds,
          correct,
          total,
        },
        opts.config.score,
      );
      await store.save({ ...file, chunks: { ...file.chunks, [session.chunkId]: after } });
      return { passed, correct, total, needed, before, after, alreadyScored: false };
    },
    { env, label: 'quiz', ...opts.lock },
  );
}
