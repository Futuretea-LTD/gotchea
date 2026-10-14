// Choosing a chunk and its questions (M3_DESIGN.md §2). Pure: no I/O, no answer key.
// Priority comes from `score/` (`selectionPriority`); nothing is duplicated here.
import type { GotcheaConfig } from '../config/schema.js';
import { matchesFilter } from '../map/tree.js';
import type { Chunk } from '../model/chunk.js';
import type { ChunkState, Progress } from '../model/progress.js';
import type { QuestionPrivate } from '../model/question.js';
import { selectionPriority } from '../score/state.js';
import { isUsable } from '../store/question-pool.js';
import { type Rng, shuffle } from './rng.js';

export type QuizTarget = { path?: string; chunkId?: string };

export type QuizSelectErrorCode = 'unknown_chunk' | 'not_leaf' | 'no_match' | 'no_quizzable_chunk' | 'not_enough_questions';

export class QuizSelectError extends Error {
  override readonly name = 'QuizSelectError';

  constructor(
    readonly code: QuizSelectErrorCode,
    message: string,
    readonly detail: { chunkId?: string; have?: number; need?: number } = {},
  ) {
    super(message);
  }
}

type SelectChunk = Pick<Chunk, 'id' | 'isLeaf' | 'aliases' | 'metrics' | 'questionCount'>;

export interface SelectChunkInput {
  chunks: readonly SelectChunk[];
  /** Usable questions per leaf (`okQuestionCounts`); missing = 0. */
  usable: ReadonlyMap<string, number>;
  /** `computeTreeStates` output at the caller's `now`. */
  states: ReadonlyMap<string, Pick<ChunkState, 'R' | 'color'>>;
  progress: Readonly<Record<string, Pick<Progress, 'mustRepass'>>>;
  target: QuizTarget;
  /** Requested session size; undefined = the chunk's questionCount. */
  count: number | undefined;
  cfg: Pick<GotcheaConfig['quiz'], 'fanInWeight' | 'minQuestions'>;
}

export interface ChunkSelection {
  chunkId: string;
  /** Session size actually used. */
  size: number;
  /** `selectionPriority` of the winner; null when the chunk was named explicitly. */
  priority: number | null;
  /** Every candidate was green: a "keep it fresh" review, not a due one. */
  allGreen: boolean;
}

/** `clamp(requested ?? questionCount, min(minQuestions, questionCount), questionCount)`. */
export function sessionSize(chunk: Pick<Chunk, 'questionCount'>, requested: number | undefined, cfg: Pick<GotcheaConfig['quiz'], 'minQuestions'>): number {
  const max = chunk.questionCount;
  const min = Math.min(cfg.minQuestions, max);
  return Math.min(max, Math.max(min, requested ?? max));
}

export function selectChunk(input: SelectChunkInput): ChunkSelection {
  const { chunks, usable, states, progress, target, count, cfg } = input;
  const have = (c: SelectChunk) => usable.get(c.id) ?? 0;

  if (target.chunkId !== undefined) {
    const id = target.chunkId;
    const chunk = chunks.find((c) => c.id === id) ?? chunks.find((c) => c.aliases?.includes(id));
    if (!chunk) throw new QuizSelectError('unknown_chunk', `No chunk with id "${id}".`, { chunkId: id });
    if (!chunk.isLeaf) throw new QuizSelectError('not_leaf', `"${chunk.id}" is a container, not a leaf. Pass it as a path instead.`, { chunkId: chunk.id });
    const size = sessionSize(chunk, count, cfg);
    if (have(chunk) < size) {
      throw new QuizSelectError('not_enough_questions', `"${chunk.id}" has ${have(chunk)} usable questions, ${size} needed.`, {
        chunkId: chunk.id,
        have: have(chunk),
        need: size,
      });
    }
    return { chunkId: chunk.id, size, priority: null, allGreen: states.get(chunk.id)?.color === 'green' };
  }

  const filter = target.path ?? '.';
  const matching = chunks.filter((c) => c.isLeaf && matchesFilter(c.id, filter));
  if (matching.length === 0) throw new QuizSelectError('no_match', `No chunk matches "${filter}".`);

  let best: { chunk: SelectChunk; size: number; priority: number; R: number } | null = null;
  let candidates = 0;
  let allGreen = true;
  let bestShort: { chunk: SelectChunk; have: number; need: number } | null = null;
  for (const chunk of matching) {
    const size = sessionSize(chunk, count, cfg);
    if (have(chunk) < size) {
      if (!bestShort || have(chunk) > bestShort.have) bestShort = { chunk, have: have(chunk), need: size };
      continue;
    }
    candidates++;
    const state = states.get(chunk.id);
    if (state?.color !== 'green') allGreen = false;
    // A chunk that must be re-passed outranks a high-R one.
    const R = progress[chunk.id]?.mustRepass ? 0 : (state?.R ?? 0);
    const priority = selectionPriority(R, chunk.metrics.fanIn, cfg);
    const better =
      best === null ||
      priority > best.priority ||
      (priority === best.priority &&
        (chunk.metrics.fanIn > best.chunk.metrics.fanIn ||
          (chunk.metrics.fanIn === best.chunk.metrics.fanIn && (R < best.R || (R === best.R && chunk.id < best.chunk.id)))));
    if (better) best = { chunk, size, priority, R };
  }
  if (best === null) {
    throw new QuizSelectError('no_quizzable_chunk', 'No chunk here has enough usable questions yet.', {
      ...(bestShort ? { chunkId: bestShort.chunk.id, have: bestShort.have, need: bestShort.need } : {}),
    });
  }
  return { chunkId: best.chunk.id, size: best.size, priority: best.priority, allGreen: candidates > 0 && allGreen };
}

export interface SelectQuestionsInput {
  pool: readonly Pick<QuestionPrivate, 'id' | 'type' | 'lang' | 'status' | 'flagged' | 'chunkHash'>[];
  chunkHash: string;
  size: number;
  /** Preferred language; other languages only fill the session. */
  lang: string;
  /** Oldest-first session history of this chunk (`Progress.history`). */
  history: readonly { questionIds: readonly string[] }[];
  excludeRecentSessions: number;
  rng: Rng;
}

/**
 * Ordered question ids for one session: preferred language first, then questions not
 * asked in the last `excludeRecentSessions` sessions, then the longest ago asked; types are
 * balanced and the final order is shuffled.
 */
export function selectQuestions(input: SelectQuestionsInput): string[] {
  const { size, history, rng } = input;
  const usable = input.pool.filter((q) => isUsable(q, input.chunkHash));
  if (usable.length < size) {
    throw new QuizSelectError('not_enough_questions', `${usable.length} usable questions, ${size} needed.`, { have: usable.length, need: size });
  }
  const askedAgo = (id: string): number => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i]!.questionIds.includes(id)) return history.length - 1 - i;
    return Number.POSITIVE_INFINITY;
  };
  const keyed = usable.map((q) => {
    const ago = askedAgo(q.id);
    return { q, tier: q.lang === input.lang ? 0 : 1, recent: ago < input.excludeRecentSessions ? 1 : 0, ago, tie: rng.int(1 << 30) };
  });
  keyed.sort((a, b) => a.tier - b.tier || a.recent - b.recent || (a.ago === b.ago ? 0 : b.ago > a.ago ? 1 : -1) || a.tie - b.tie);

  const types = new Set(keyed.map((k) => k.q.type)).size;
  const cap = Math.ceil(size / types);
  const taken = new Map<string, number>();
  const chosen: typeof keyed = [];
  for (const k of keyed) {
    if (chosen.length === size) break;
    const n = taken.get(k.q.type) ?? 0;
    if (n >= cap) continue;
    taken.set(k.q.type, n + 1);
    chosen.push(k);
  }
  for (const k of keyed) {
    if (chosen.length === size) break;
    if (!chosen.includes(k)) chosen.push(k);
  }
  return shuffle(
    chosen.map((k) => k.q.id),
    rng,
  );
}
