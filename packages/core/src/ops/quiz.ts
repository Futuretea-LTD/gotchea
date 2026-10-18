// The quiz engine (M3_DESIGN.md §6): the only code that selects, grades and scores. The MCP tools
// and the CLI are renderers over it. Results carry views only: a question's key, explanation and
// refs leave this module only as a `RevealView`, after the answer was recorded.
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import { LangCodeSchema } from '../generate/schema.js';
import { SourceReader } from '../generate/source.js';
import { matchesFilter } from '../map/tree.js';
import { buildMiniHeatmap, type MiniHeatmap } from '../map/mini-heatmap.js';
import { okQuestionCounts } from '../map/question-counts.js';
import type { Chunk } from '../model/chunk.js';
import type { ChunkColor } from '../model/progress.js';
import { now as currentTime } from '../now.js';
import { type ParserRegistry, createDefaultRegistry } from '../parse/registry.js';
import { type QuizSelectErrorCode, QuizSelectError, selectChunk, selectQuestions } from '../quiz/select.js';
import { type QuizSessions, type Session, type SessionErrorCode, type SessionOrigin, SessionError, scoreSession } from '../quiz/session.js';
import { type Rng, cryptoRng } from '../quiz/rng.js';
import { sanitizeTerminalText } from '../quiz/sanitize.js';
import {
  type PrivateQuestionView,
  type PublicCodePreview,
  type PublicQuestionView,
  type RevealView,
  PublicCodePreviewSchema,
  REF_EXCERPT_MAX_LINES,
  REVEAL_EXCERPT_MAX_LINES,
  RevealRefSchema,
  assertPublicView,
  codePreview,
  toPrivateView,
  toPublicView,
  toRevealView,
} from '../quiz/views.js';
import { computeTreeStates } from '../score/aggregate.js';
import { chunkState, passThreshold } from '../score/state.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { GOTCHEA_DIR } from '../store/paths.js';
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
  /** Attach the chunk's current source to each question view (default `quiz.showCode`); stored on a new session. */
  includeCode?: boolean | undefined;
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
  /** Attach the chunk's source to the `next` question view (default: the session's stored choice). */
  includeCode?: boolean | undefined;
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

// Built once: only the extension map is used, so no grammar is loaded here.
let languageRegistry: ParserRegistry | undefined;
function languageOf(path: string, scanned: string | undefined): string {
  languageRegistry ??= createDefaultRegistry();
  return languageRegistry.forPath(path)?.lang ?? scanned ?? 'text';
}

/**
 * True when `path` is repo-relative and resolves, symlinks included, to a file under `root` but
 * outside `.gotchea/`. chunks.json is committed and hand-editable, so its paths are not trusted to
 * stay in the repo, nor out of the answer files: the fallback chunker accepts any file, so a forged
 * chunk there would pass the hash check and put the key in a pre-answer view.
 */
async function insideRoot(root: string, path: string): Promise<boolean> {
  if (path === '' || path.includes('\\') || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path)) return false;
  if (path.split('/').includes('..')) return false;
  try {
    const [base, real] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
    const rel = relative(base, real);
    const first = rel.split(sep)[0]!;
    return rel !== '' && first !== '..' && first.toLowerCase() !== GOTCHEA_DIR && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * The chunk's sanitized working-tree lines, or null when they can't be shown faithfully: a file
 * that is missing or outside the repo, or a chunk whose current hash (re-chunked like a scan does)
 * no longer matches chunks.json, so its lines may not be the code the questions were written for.
 * Per line, after splitting: a stray `\r` becomes a stand-in, never a line break, so line counts
 * still match the scanned ranges. Never throws: code is optional and a stale chunk is reported elsewhere.
 */
async function sanitizedLines(root: string, chunk: Chunk, config: GotcheaConfig, path: string): Promise<string[] | null> {
  if (!(await insideRoot(root, path))) return null;
  try {
    const reader = new SourceReader(root, config);
    if ((await reader.currentHash(chunk)) !== chunk.contentHash) return null;
    return (await reader.lines(path)).map(sanitizeTerminalText);
  } catch {
    return null;
  }
}

/** Multi-range chunks (a `~body` remainder) get none, since one line span can't describe them. */
async function chunkPreview(root: string, chunk: Chunk, config: GotcheaConfig): Promise<PublicCodePreview | null> {
  const range = chunk.ranges.length === 1 ? chunk.ranges[0]! : undefined;
  if (!range) return null;
  const all = await sanitizedLines(root, chunk, config, range.path);
  if (!all) return null;
  const language = sanitizeTerminalText(languageOf(range.path, chunk.lang));
  const preview = codePreview(sanitizeTerminalText(range.path), range.start, language, all.slice(range.start - 1, range.end));
  // A hand-edited chunk (e.g. an empty `lang`) must cost the preview, not fail assertPublicView and the quiz.
  return preview && PublicCodePreviewSchema.safeParse(preview).success ? preview : null;
}

/**
 * Adds the cited source to each exact ref of a reveal, within the per-ref and per-reveal caps.
 * Approximate refs keep numbers only: their range may point at the wrong lines. Called after the
 * answer is recorded, and only with previews on, so closed-book sessions never see code here.
 */
async function withRefExcerpts(root: string, chunk: Chunk, config: GotcheaConfig, reveal: RevealView): Promise<RevealView> {
  let budget = REVEAL_EXCERPT_MAX_LINES;
  const cache = new Map<string, string[] | null>();
  const refs: RevealView['refs'] = [];
  for (const ref of reveal.refs) {
    // Only ranges of this chunk are citable, so a ref can't name an arbitrary file.
    const owned = chunk.ranges.some((r) => r.path === ref.path && ref.startLine >= r.start && ref.endLine <= r.end);
    if (!owned || ref.approximate || budget <= 0 || ref.endLine < ref.startLine) {
      refs.push(ref);
      continue;
    }
    if (!cache.has(ref.path)) cache.set(ref.path, await sanitizedLines(root, chunk, config, ref.path));
    const all = cache.get(ref.path);
    const slice = all?.slice(ref.startLine - 1, ref.endLine);
    if (!slice || slice.length === 0) {
      refs.push(ref);
      continue;
    }
    const kept = slice.slice(0, Math.min(REF_EXCERPT_MAX_LINES, budget));
    budget -= kept.length;
    const language = sanitizeTerminalText(languageOf(ref.path, chunk.lang));
    const excerpt = { language, text: kept.join('\n'), ...(kept.length < slice.length ? { truncated: true as const } : {}) };
    const withExcerpt = { ...ref, excerpt };
    refs.push(RevealRefSchema.safeParse(withExcerpt).success ? withExcerpt : ref);
  }
  return { ...reveal, refs };
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
  const now = deps.now ? deps.now() : currentTime(env);
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
    // An explicit includeCode applies to this response only; a resumed session keeps its stored
    // choice for later `next` questions, so one call can't silently flip the mode mid-quiz.
    const code = (input.includeCode ?? session.showCode ?? true) ? await chunkPreview(root, chunk, config) : null;
    return assertPublicView(toPublicView(q, session.permutations[id]!, session.questionIds.indexOf(id) + 1, session.questionIds.length, code));
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
  const showCode = input.includeCode ?? config.quiz.showCode;
  const session = await sessions.create({ origin: deps.origin, chunkId: chunk.id, chunkHash: chunk.contentHash, lang, questionIds, showCode });
  const question = await viewOf(session);
  if (!question) return refuseStart('not_enough_questions', `"${chunk.id}" has no usable questions.`, { chunkId: chunk.id });
  return { status: 'started', session: header(session, chunk, needed(questionIds.length)), question };
}

export async function submitAnswer(root: string, input: SubmitAnswerInput, deps: QuizOpsDeps): Promise<SubmitAnswerResult> {
  const { sessions } = deps;
  const config = deps.config ?? (await loadConfig(root));
  const env = deps.env ?? process.env;
  const now = deps.now ? deps.now() : currentTime(env);
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
  const showCode = input.includeCode ?? done.showCode ?? true;
  const revealed = toRevealView(private_, input.displayIndex, chunk);
  const reveal = showCode ? await withRefExcerpts(root, chunk, config, revealed) : revealed;
  const answered = done.questionIds.filter((q) => done.answers[q]).length;
  const progress = { answered, total, correct: done.questionIds.filter((q) => done.answers[q]?.correct).length };
  const base = { repeat: recorded.repeat, sessionId: done.id, reveal, progress };

  const nextId = nextUnanswered(done);
  if (nextId !== undefined) {
    const nq = (await new FsQuestionStore(root).list(chunk.id)).find((q) => q.id === nextId);
    if (!nq || !isUsable(nq, done.chunkHash)) return refuseSubmit('question_unavailable');
    const code = showCode ? await chunkPreview(root, chunk, config) : null;
    return { status: 'answered', ...base, next: assertPublicView(toPublicView(nq, done.permutations[nextId]!, answered + 1, total, code)) };
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
