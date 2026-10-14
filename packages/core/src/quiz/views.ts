// Public and private question views (M3_DESIGN.md §4). The public view is all that may
// cross an interface boundary before submit: stem and display-indexed options. Correctness,
// explanation and line references live in the private view and leave only as a reveal after
// the answer was recorded. All schemas are strict: unknown keys are rejected.
import { z } from 'zod';
import { chunkLineCount } from '../generate/chunk-code.js';
import type { Chunk } from '../model/chunk.js';
import type { QuestionPrivate, QuestionRef } from '../model/question.js';
import type { Permutation } from './rng.js';

export const LABELS = ['A', 'B', 'C', 'D'] as const;

const OptionViewSchema = z.strictObject({ index: z.number().int().min(0).max(3), label: z.enum(LABELS), text: z.string() });

/** Crosses the interface boundary BEFORE submit. Nothing else may. */
export const PublicQuestionViewSchema = z
  .strictObject({
    questionId: z.string().regex(/^q_[0-9a-f]{12}$/),
    /** 1-based position in the session. */
    position: z.number().int().min(1),
    total: z.number().int().min(1),
    stem: z.string(),
    options: z.tuple([OptionViewSchema, OptionViewSchema, OptionViewSchema, OptionViewSchema]),
  })
  .refine((v) => v.options.every((o, i) => o.index === i && o.label === LABELS[i]), 'options must be indexed 0-3 in order');

export type PublicQuestionView = z.infer<typeof PublicQuestionViewSchema>;

export const RevealRefSchema = z.strictObject({ path: z.string(), startLine: z.number().int(), endLine: z.number().int(), approximate: z.boolean() });

/** Crosses the boundary only AFTER the answer for that question was recorded. */
export const RevealViewSchema = z.strictObject({
  questionId: z.string(),
  correct: z.boolean(),
  selectedDisplayIndex: z.number().int().min(0).max(3),
  correctDisplayIndex: z.number().int().min(0).max(3),
  correctText: z.string(),
  explanation: z.string(),
  refs: z.array(RevealRefSchema),
});

export type RevealView = z.infer<typeof RevealViewSchema>;

/** Internal: produced inside core, never returned by a public API. */
export interface PrivateQuestionView extends PublicQuestionView {
  correctDisplayIndex: 0 | 1 | 2 | 3;
  explanation: string;
  /** Chunk-relative. */
  refs: QuestionRef[];
  chunkLines: number;
}

/** Keys that must never appear in a pre-submit value, at any depth. */
export const FORBIDDEN_KEYS = ['correctIndex', 'correctDisplayIndex', 'correctOptionIndex', 'correctText', 'explanation', 'refs', 'answer', 'key'] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_KEYS);

function scanKeys(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) scanKeys(x, `${path}[${i}]`);
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.has(k)) throw new Error(`Forbidden key "${k}" in public view at ${path || '<root>'}`);
      scanKeys(x, path ? `${path}.${k}` : k);
    }
  }
}

/** Strict schema parse plus a deep forbidden-key scan (defence in depth against a future field). */
export function assertPublicView(v: unknown): PublicQuestionView {
  scanKeys(v, '');
  return PublicQuestionViewSchema.parse(v);
}

const display = (q: Pick<QuestionPrivate, 'options'>, perm: Permutation): PublicQuestionView['options'] =>
  [0, 1, 2, 3].map((d) => ({ index: d, label: LABELS[d]!, text: q.options[perm[d]!]! })) as PublicQuestionView['options'];

/** Copies fields explicitly. The parameter type cannot even name the key. */
export function toPublicView(q: Pick<QuestionPrivate, 'id' | 'stem' | 'options'>, perm: Permutation, position: number, total: number): PublicQuestionView {
  return { questionId: q.id, position, total, stem: q.stem, options: display(q, perm) };
}

export function toPrivateView(q: QuestionPrivate, perm: Permutation, position: number, total: number): PrivateQuestionView {
  return {
    ...toPublicView(q, perm, position, total),
    correctDisplayIndex: perm.indexOf(q.correctIndex) as 0 | 1 | 2 | 3,
    explanation: q.explanation,
    refs: q.refs.map((r) => ({ start: r.start, end: r.end })),
    chunkLines: q.chunkLines,
  };
}

/**
 * Chunk-relative refs → absolute lines, one entry per range the ref touches (a ref that spans a
 * multi-range boundary is split). Approximate when the chunk's line count differs from
 * `chunkLines`; approximate refs are clamped to the chunk.
 */
function absoluteRefs(refs: readonly QuestionRef[], chunk: Pick<Chunk, 'ranges'>, chunkLines: number): RevealView['refs'] {
  const total = chunkLineCount(chunk);
  const approximate = chunkLines > 0 && total !== chunkLines;
  const out: RevealView['refs'] = [];
  for (const ref of refs) {
    const start = Math.max(1, ref.start);
    const end = Math.min(total, ref.end);
    let offset = 0;
    for (const r of chunk.ranges) {
      const size = Math.max(0, r.end - r.start + 1);
      const lo = Math.max(start, offset + 1);
      const hi = Math.min(end, offset + size);
      if (lo <= hi) out.push({ path: r.path, startLine: r.start + lo - offset - 1, endLine: r.start + hi - offset - 1, approximate });
      offset += size;
    }
  }
  return out;
}

export function toRevealView(pv: PrivateQuestionView, selectedDisplayIndex: number, chunk: Pick<Chunk, 'ranges'>): RevealView {
  return {
    questionId: pv.questionId,
    correct: selectedDisplayIndex === pv.correctDisplayIndex,
    selectedDisplayIndex,
    correctDisplayIndex: pv.correctDisplayIndex,
    correctText: pv.options[pv.correctDisplayIndex]!.text,
    explanation: pv.explanation,
    refs: absoluteRefs(pv.refs, chunk, pv.chunkLines),
  };
}
