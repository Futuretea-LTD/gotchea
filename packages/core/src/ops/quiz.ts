// The quiz engine (M3_DESIGN.md §6): the only code that selects, grades and scores. The MCP tools
// and the CLI are renderers over it. Results carry views only: a question's key, explanation and
// refs leave this module only as a `RevealView`, after the answer was recorded.
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { LangCodeSchema } from '../generate/schema.js';
import { matchesFilter } from '../map/tree.js';
import { buildMiniHeatmap, type MiniHeatmap } from '../map/mini-heatmap.js';
import { okQuestionCounts } from '../map/question-counts.js';
import type { Chunk } from '../model/chunk.js';
import type { ChunkColor } from '../model/progress.js';
import { type QuizSelectErrorCode, QuizSelectError, selectChunk, selectQuestions } from '../quiz/select.js';
import { type QuizSessions, type Session, type SessionErrorCode, type SessionOrigin, SessionError, scoreSession } from '../quiz/session.js';
import { type Rng, cryptoRng } from '../quiz/rng.js';
import {
  type PrivateQuestionView,
  type PublicQuestionView,
  type RevealView,
  assertPublicView,
  toPrivateView,
  toPublicView,
  toRevealView,
} from '../quiz/views.js';
import { computeTreeStates } from '../score/aggregate.js';
import { chunkState, passThreshold } from '../score/state.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { FsProgressStore } from '../store/progress-store.js';
import { isUsable } from '../store/question-pool.js';
import { FsQuestionStore } from '../store/question-store.js';
import { computeRepoId } from '../store/repo-id.js';
import { ensureReconciled } from './reconcile.js';

export interface StartQuizInput {
  path?: string | undefined;
  chunkId?: string | undefined;
  count?: number | undefined;
  lang?: string | undefined;
}

export interface QuizOpsDeps {
  /** Shared per process (MCP server) or per command (CLI). */
  sessions: QuizSessions;
  origin: SessionOrigin;
  config?: GotcheaConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  rng?: Rng;
}

export interface SessionHeader {
  id: string;
  chunkId: string;
  chunkTitle: string;
  path: string | null;
  total: number;
  answered: number;
  /** Correct answers needed to pass. */
  needed: number;
  expiresAt: string;
}

export type StartQuizRefusal = QuizSelectErrorCode | 'both_targets' | 'not_scanned' | 'lang_invalid';

export type StartQuizResult =
  | { status: 'started' | 'resumed'; session: SessionHeader; question: PublicQuestionView }
  | { status: 'refused'; reason: StartQuizRefusal; message: string; detail: { chunkId?: string; have?: number; need?: number } };

export interface SubmitAnswerInput {
  sessionId: string;
  questionId: string;
  displayIndex: number;
}

export interface SessionResultView {
  passed: boolean;
  correct: number;
  total: number;
  needed: number;
  chunk: { id: string; title: string; path: string | null };
  before: { color: ChunkColor; R: number | null };
  after: { color: ChunkColor; R: number | null; dueAt: string | null };
  stabilityDays: number | null;
  heatmap: MiniHeatmap;
}

export type SubmitRefusal = SessionErrorCode | 'chunk_changed' | 'question_unavailable';

export type SubmitAnswerResult =
  | {
      status: 'answered';
      repeat: boolean;
      sessionId: string;
      reveal: RevealView;
      progress: { answered: number; total: number; correct: number };
      next: PublicQuestionView;
    }
  | {
      status: 'completed';
      repeat: boolean;
      sessionId: string;
      reveal: RevealView;
      progress: { answered: number; total: number; correct: number };
      result: SessionResultView;
    }
  | { status: 'refused'; reason: SubmitRefusal; message: string };

const refuseStart = (reason: StartQuizRefusal, message: string, detail: { chunkId?: string; have?: number; need?: number } = {}): StartQuizResult => ({
  status: 'refused',
  reason,
  message,
  detail,
});

const refuseSubmit = (reason: SubmitRefusal, message: string = reason): SubmitAnswerResult => ({ status: 'refused', reason, message });

const pathOf = (c: Pick<Chunk, 'ranges'>): string | null => c.ranges[0]?.path ?? null;

function header(session: Session, chunk: Chunk, needed: number): SessionHeader {
  return {
    id: session.id,
    chunkId: chunk.id,
    chunkTitle: chunk.title,
    path: pathOf(chunk),
    total: session.questionIds.length,
    answered: session.questionIds.filter((q) => session.answers[q]).length,
    needed,
    expiresAt: session.expiresAt,
  };
}

function nextUnanswered(session: Session): string | undefined {
  return session.questionIds.find((q) => !session.answers[q]);
}

/** Chunk ids a target can resolve to; sessions in this scope may be resumed. */
function scopeOf(chunks: readonly Chunk[], input: StartQuizInput): Set<string> {
  if (input.chunkId !== undefined) {
    const hit = chunks.find((c) => c.id === input.chunkId) ?? chunks.find((c) => c.aliases?.includes(input.chunkId!));
    return new Set(hit ? [hit.id] : []);
  }
  const filter = input.path ?? '.';
  return new Set(chunks.filter((c) => c.isLeaf && matchesFilter(c.id, filter)).map((c) => c.id));
}

export async function startQuiz(root: string, input: StartQuizInput, deps: QuizOpsDeps): Promise<StartQuizResult> {
  if (input.path !== undefined && input.chunkId !== undefined) return refuseStart('both_targets', 'Pass either path or chunkId, not both.');
  if (input.lang !== undefined && !LangCodeSchema.safeParse(input.lang).success) return refuseStart('lang_invalid', `"${input.lang}" is not a valid language code.`);
  const file = await new FsChunkStore(root).load();
  if (!file) return refuseStart('not_scanned', 'No scan yet.');

  const config = deps.config ?? (await loadConfig(root));
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const rng = deps.rng ?? cryptoRng;
  const repoId = await computeRepoId(root);
  const { sessions } = deps;

  await sessions.sweep();
  await ensureReconciled(root, { config, env, repoId });

  const chunks = file.chunks;
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const questionStore = new FsQuestionStore(root);
  const needed = (total: number) => passThreshold(total, config.quiz.passRatio);

  const viewOf = async (session: Session): Promise<PublicQuestionView | null> => {
    const id = nextUnanswered(session);
    const chunk = byId.get(session.chunkId);
    if (id === undefined || !chunk) return null;
    const q = (await questionStore.list(chunk.id)).find((x) => x.id === id);
    if (!q || !isUsable(q, session.chunkHash)) return null;
    return assertPublicView(toPublicView(q, session.permutations[id]!, session.questionIds.indexOf(id) + 1, session.questionIds.length));
  };

  // Resume an unfinished quiz in scope; an untouched one is replaced, so a retried call leaves no orphan.
  for (const session of await sessions.findActive({ origin: deps.origin, inChunks: scopeOf(chunks, input) })) {
    const chunk = byId.get(session.chunkId);
    const answered = Object.keys(session.answers).length;
    const view = answered > 0 && chunk?.contentHash === session.chunkHash ? await viewOf(session) : null;
    if (chunk && view) return { status: 'resumed', session: header(session, chunk, needed(session.questionIds.length)), question: view };
    await sessions.abandon(session.id);
  }

  const progress = await new FsProgressStore(repoId, env).load();
  const okQuestions = await okQuestionCounts(root, chunks);
  const states = computeTreeStates({ chunks, okQuestions, progress: progress.chunks, now, cfg: config.score });

  let selection: ReturnType<typeof selectChunk>;
  try {
    selection = selectChunk({
      chunks,
      usable: okQuestions,
      states,
      progress: progress.chunks,
      target: input.chunkId !== undefined ? { chunkId: input.chunkId } : input.path !== undefined ? { path: input.path } : {},
      count: input.count,
      cfg: config.quiz,
    });
  } catch (err) {
    if (err instanceof QuizSelectError) return refuseStart(err.code, err.message, err.detail);
    throw err;
  }
  const chunk = byId.get(selection.chunkId)!;
  const lang = input.lang ?? config.questions.lang;
  let questionIds: string[];
  try {
    questionIds = selectQuestions({
      pool: await questionStore.list(chunk.id),
      chunkHash: chunk.contentHash,
      size: selection.size,
      lang,
      history: progress.chunks[chunk.id]?.history ?? [],
      excludeRecentSessions: config.quiz.excludeRecentSessions,
      rng,
    });
  } catch (err) {
    if (err instanceof QuizSelectError) return refuseStart(err.code, err.message, { chunkId: chunk.id, ...err.detail });
    throw err;
  }
  const session = await sessions.create({ origin: deps.origin, chunkId: chunk.id, chunkHash: chunk.contentHash, lang, questionIds });
  const question = await viewOf(session);
  if (!question) return refuseStart('not_enough_questions', `"${chunk.id}" has no usable questions.`, { chunkId: chunk.id });
  return { status: 'started', session: header(session, chunk, needed(questionIds.length)), question };
}

export async function submitAnswer(root: string, input: SubmitAnswerInput, deps: QuizOpsDeps): Promise<SubmitAnswerResult> {
  const { sessions } = deps;
  const config = deps.config ?? (await loadConfig(root));
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  if (!Number.isInteger(input.displayIndex) || input.displayIndex < 0 || input.displayIndex > 3) return refuseSubmit('invalid_index', 'displayIndex must be 0-3.');

  const session = await sessions.get(input.sessionId);
  if (!session) return refuseSubmit('unknown_session', `No quiz session "${input.sessionId}".`);
  if (session.status === 'expired') return refuseSubmit('session_expired');
  if (session.status !== 'active') return refuseSubmit('session_completed');
  if (!session.questionIds.includes(input.questionId)) return refuseSubmit('unknown_question');

  const file = await new FsChunkStore(root).load();
  const chunk = file?.chunks.find((c) => c.id === session.chunkId);
  if (!file || !chunk || chunk.contentHash !== session.chunkHash) {
    await sessions.expire(session.id);
    return refuseSubmit('chunk_changed', `The code in ${session.chunkId} changed during the quiz.`);
  }
  const question = (await new FsQuestionStore(root).list(chunk.id)).find((q) => q.id === input.questionId);
  if (!question || !isUsable(question, session.chunkHash)) return refuseSubmit('question_unavailable');

  let recorded: Awaited<ReturnType<QuizSessions['recordAnswer']>>;
  try {
    recorded = await sessions.recordAnswer(session.id, input.questionId, input.displayIndex, (o) => o === question.correctIndex);
  } catch (err) {
    if (err instanceof SessionError) return refuseSubmit(err.code, err.message);
    throw err;
  }
  const done = recorded.session;
  const total = done.questionIds.length;
  const perm = done.permutations[input.questionId]!;
  const private_: PrivateQuestionView = toPrivateView(question, perm, done.questionIds.indexOf(input.questionId) + 1, total);
  const reveal = toRevealView(private_, input.displayIndex, chunk);
  const answered = done.questionIds.filter((q) => done.answers[q]).length;
  const progress = { answered, total, correct: done.questionIds.filter((q) => done.answers[q]?.correct).length };
  const base = { repeat: recorded.repeat, sessionId: done.id, reveal, progress };

  const nextId = nextUnanswered(done);
  if (nextId !== undefined) {
    const nq = (await new FsQuestionStore(root).list(chunk.id)).find((q) => q.id === nextId);
    if (!nq || !isUsable(nq, done.chunkHash)) return refuseSubmit('question_unavailable');
    return { status: 'answered', ...base, next: assertPublicView(toPublicView(nq, done.permutations[nextId]!, answered + 1, total)) };
  }

  // Last question: score under the repo lock (idempotent on the session id), then close the session.
  const repoId = await computeRepoId(root);
  const outcome = await scoreSession(done, { repoId, config, env, now });
  await sessions.markCompleted(done.id);
  const okQuestions = await okQuestionCounts(root, file.chunks);
  const after = await new FsProgressStore(repoId, env).load();
  const states = computeTreeStates({ chunks: file.chunks, okQuestions, progress: after.chunks, now, cfg: config.score });
  const ok = okQuestions.get(chunk.id) ?? total;
  const stateBefore = chunkState(ok, outcome.before, now, config.score);
  const stateAfter = chunkState(ok, outcome.after, now, config.score);
  const result: SessionResultView = {
    passed: outcome.passed,
    correct: outcome.correct,
    total: outcome.total,
    needed: outcome.needed,
    chunk: { id: chunk.id, title: chunk.title, path: pathOf(chunk) },
    before: { color: stateBefore.color, R: stateBefore.R },
    after: { color: stateAfter.color, R: stateAfter.R, dueAt: stateAfter.dueAt ?? null },
    stabilityDays: outcome.after.stability,
    heatmap: buildMiniHeatmap(file.chunks, states, chunk.id),
  };
  return { status: 'completed', ...base, result };
}

/** Ends an unfinished session without scoring it. */
export async function abandonQuiz(sessionId: string, deps: Pick<QuizOpsDeps, 'sessions'>): Promise<void> {
  await deps.sessions.abandon(sessionId);
}
