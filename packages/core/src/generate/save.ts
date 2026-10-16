import { now as currentTime } from '../now.js';
// The one write path for generated questions (M2_DESIGN.md §8.2, decision D6):
// call-level gate (chunk exists, is a leaf, hash matches) → validator → stamp →
// persist under the per-chunk lock. The result carries indices, ids, reason codes
// and fixed-template details only, never a stem, option, key or explanation (PLAN §6).
import { loadConfig } from '../config/load.js';
import type { GotcheaConfig } from '../config/schema.js';
import type { Chunk } from '../model/chunk.js';
import { dedupeBase, insertQuestions, usableQuestions } from '../store/question-pool.js';
import { FsQuestionStore } from '../store/question-store.js';
import { FsChunkStore } from '../store/chunk-store.js';
import { computeRepoId } from '../store/repo-id.js';
import { withRepoLock } from '../store/repo-lock.js';
import type { QuestionStore } from '../store/types.js';
import { chunkLineCount } from './chunk-code.js';
import { LangCodeSchema } from './schema.js';
import { SourceReader } from './source.js';
import { stampQuestion } from './stamp.js';
import type { QuestionPrivate } from '../model/question.js';
import type { VerifyOutcome } from './verify.js';
import { poolTarget } from './tasks.js';
import { type Rejection, validateBatch } from './validate.js';

export const SAVE_REJECT_REASONS = [
  'not_scanned',
  'unknown_chunk',
  'not_leaf',
  'chunk_hash_mismatch',
  'chunk_changed_since_scan',
  'lang_invalid',
  'batch_too_large',
] as const;
/** Why a whole save call was refused; nothing is persisted. */
export type SaveRejectReason = (typeof SAVE_REJECT_REASONS)[number];

export interface SaveInput {
  /** Current id or an alias of it. */
  chunkId: string;
  /** The `chunkHash` of the generation task the questions were written against. */
  chunkHash: string;
  /** Defaults to `config.questions.lang`. */
  lang?: string;
  /** Raw question items; validated one by one. */
  questions: readonly unknown[];
}

export interface SaveOptions {
  /** 'host:<client>' | '<provider>:<model>'. */
  generatedBy: string;
  config?: GotcheaConfig;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a per-root FsQuestionStore shared within this process (so its lock serialises writers). */
  store?: QuestionStore;
  /**
   * Optional blind verify (§5), run on each accepted question after validation and
   * before persist. Its outcome sets `flagged` / `verifiedBy`; CLI only (decision D7).
   */
  verify?: (question: QuestionPrivate) => Promise<VerifyOutcome>;
}

export type SaveResult =
  | { status: 'rejected'; reason: SaveRejectReason; message: string; chunkId: string }
  | {
      status: 'saved';
      /** Resolved current chunk id. */
      chunkId: string;
      /** `flagged`: the blind verify disagreed with the key (saved for review, not usable). */
      accepted: { index: number; id: string; flagged: boolean }[];
      rejected: Rejection[];
      /** Blind verify failures (the question is saved unverified); never contains the key. */
      verifyErrors: string[];
      /** After the save. */
      usableQuestions: number;
      target: number;
    };

const stores = new Map<string, FsQuestionStore>();
function sharedStore(root: string): FsQuestionStore {
  let s = stores.get(root);
  if (!s) {
    s = new FsQuestionStore(root);
    stores.set(root, s);
  }
  return s;
}

const reject = (chunkId: string, reason: SaveRejectReason, message: string): SaveResult => ({ status: 'rejected', reason, message, chunkId });

export async function saveQuestions(root: string, input: SaveInput, opts: SaveOptions): Promise<SaveResult> {
  const config = opts.config ?? (await loadConfig(root));
  const file = await new FsChunkStore(root).load();
  if (!file) return reject(input.chunkId, 'not_scanned', 'No scan yet: run `gotchea scan` first.');

  const chunk: Chunk | undefined =
    file.chunks.find((c) => c.id === input.chunkId) ?? file.chunks.find((c) => c.aliases?.includes(input.chunkId));
  if (!chunk) {
    return reject(input.chunkId, 'unknown_chunk', `Unknown chunk ${input.chunkId}: call get_generation_tasks again.`);
  }
  if (!chunk.isLeaf) return reject(chunk.id, 'not_leaf', `${chunk.id} is not a leaf chunk; questions belong to leaf chunks.`);
  if (input.chunkHash !== chunk.contentHash) {
    return reject(chunk.id, 'chunk_hash_mismatch', `The code of ${chunk.id} changed since the task was issued: call get_generation_tasks again.`);
  }
  if ((await new SourceReader(root, config).currentHash(chunk)) !== chunk.contentHash) {
    return reject(chunk.id, 'chunk_changed_since_scan', `${chunk.id} was edited after the last scan: run scan, then get_generation_tasks again.`);
  }
  const lang = LangCodeSchema.safeParse(input.lang ?? config.questions.lang);
  if (!lang.success) return reject(chunk.id, 'lang_invalid', 'lang must be a language code such as en, tr or pt-BR.');
  if (input.questions.length > config.questions.maxBatch) {
    return reject(chunk.id, 'batch_too_large', `At most ${config.questions.maxBatch} questions per call; got ${input.questions.length}.`);
  }

  const store = opts.store ?? sharedStore(root);
  const chunkLines = chunkLineCount(chunk);
  const validation = validateBatch({
    items: input.questions,
    chunkLineCount: chunkLines,
    existing: dedupeBase(await store.list(chunk.id), chunk.contentHash).map((q) => ({ id: q.id, stem: q.stem })),
    cfg: config.questions,
  });

  const now = opts.now ?? currentTime(opts.env);
  const verifyErrors: string[] = [];
  const stamped: { index: number; question: QuestionPrivate }[] = [];
  for (const { index, question } of validation.accepted) {
    const meta = { chunkId: chunk.id, chunkHash: chunk.contentHash, chunkLines, lang: lang.data, generatedBy: opts.generatedBy, now };
    let q = stampQuestion(question, meta);
    if (opts.verify) {
      const outcome = await opts.verify(q);
      if (outcome.error !== undefined) verifyErrors.push(outcome.error);
      q = stampQuestion(question, { ...meta, flagged: outcome.flagged, verifiedBy: outcome.verifiedBy });
    }
    stamped.push({ index, question: q });
  }
  // Gate re-check and insert under the repo lock: a scan may have run during validate and blind verify.
  const inserted = await withRepoLock(
    await computeRepoId(root),
    async () => {
      const fresh = (await new FsChunkStore(root).load())?.chunks.find((c) => c.id === chunk.id);
      if (!fresh || fresh.contentHash !== chunk.contentHash) return null;
      return stamped.length > 0
        ? insertQuestions(
            store,
            chunk.id,
            stamped.map((s) => s.question),
          )
        : { duplicateIds: [] as string[], pool: await store.list(chunk.id) };
    },
    { env: opts.env ?? process.env, label: 'save_questions' },
  );
  if (inserted === null) {
    return reject(chunk.id, 'chunk_hash_mismatch', `The code of ${chunk.id} changed since the task was issued: call get_generation_tasks again.`);
  }

  // The validator saw the pool before the lock; a concurrent save can still land the same id first.
  const late = new Set(inserted.duplicateIds);
  const accepted: { index: number; id: string; flagged: boolean }[] = [];
  const rejected: Rejection[] = [...validation.rejected];
  for (const { index, question } of stamped) {
    if (late.has(question.id)) rejected.push({ index, reason: 'duplicate_stored', detail: `near-duplicate of stored question ${question.id} (J=1.00)` });
    else accepted.push({ index, id: question.id, flagged: question.flagged });
  }
  rejected.sort((a, b) => a.index - b.index);

  return {
    status: 'saved',
    chunkId: chunk.id,
    accepted,
    rejected,
    verifyErrors,
    usableQuestions: usableQuestions(inserted.pool, chunk.contentHash).length,
    target: poolTarget(chunk, config.questions),
  };
}
