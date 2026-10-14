// Turning an accepted raw question into a stored one (M2_DESIGN.md §2.2). Identity
// and metadata fields are always stamped here, never taken from the raw input.
import { sha256Hex } from '../hash/hash.js';
import type { QuestionPrivate } from '../model/question.js';
import { PROMPT_VERSION } from './prompt.js';
import type { RawQuestion } from './schema.js';
import { normalizeText } from './text.js';

/** Deterministic: an identical resubmission gets the same id (and is rejected as a duplicate). */
export function questionId(chunkId: string, chunkHash: string, stem: string): string {
  return `q_${sha256Hex(`${chunkId}\n${chunkHash}\n${normalizeText(stem)}`).slice(0, 12)}`;
}

export interface StampMeta {
  chunkId: string;
  chunkHash: string;
  /** Line count of the numbered code the question was written against. */
  chunkLines: number;
  lang: string;
  generatedBy: string;
  now: Date;
  promptVersion?: string;
  flagged?: boolean;
  verifiedBy?: string | null;
}

export function stampQuestion(raw: RawQuestion, meta: StampMeta): QuestionPrivate {
  return {
    id: questionId(meta.chunkId, meta.chunkHash, raw.stem),
    chunkId: meta.chunkId,
    chunkHash: meta.chunkHash,
    chunkLines: meta.chunkLines,
    type: raw.type,
    stem: raw.stem,
    options: [...raw.options],
    correctIndex: raw.correctIndex,
    explanation: raw.explanation,
    refs: raw.refs.map((r) => ({ start: r.start, end: r.end })),
    difficulty: raw.difficulty,
    lang: meta.lang,
    generatedBy: meta.generatedBy,
    promptVersion: meta.promptVersion ?? PROMPT_VERSION,
    status: 'ok',
    flagged: meta.flagged ?? false,
    verifiedBy: meta.verifiedBy ?? null,
    createdAt: meta.now.toISOString(),
  };
}
