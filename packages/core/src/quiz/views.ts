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

/** Longest code preview sent with a question; longer chunks are cut and marked `truncated`. */
export const CODE_PREVIEW_MAX_LINES = 60;

/**
 * The chunk's current source, shown with the question. It is the code the question is about, so
 * it gives nothing away the user could not read in their editor; it never carries refs, the
 * explanation or anything else derived from the answer.
 */
export const PublicCodePreviewSchema = z
  .strictObject({
    /** Repo-relative, POSIX separators. */
    path: z.string().min(1),
    /** 1-based, inclusive: the lines actually in `text`. */
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    language: z.string().min(1),
    text: z.string(),
    /** Present only when the chunk is longer than `CODE_PREVIEW_MAX_LINES`. */
    truncated: z.literal(true).optional(),
  })
  .refine((c) => c.endLine >= c.startLine, 'endLine must be >= startLine')
  .refine((c) => c.endLine - c.startLine + 1 <= CODE_PREVIEW_MAX_LINES, `at most ${CODE_PREVIEW_MAX_LINES} lines`)
  .refine((c) => c.text.split('\n').length === c.endLine - c.startLine + 1, 'text must hold exactly startLine..endLine');

export type PublicCodePreview = z.infer<typeof PublicCodePreviewSchema>;

/**
 * Crosses the interface boundary BEFORE submit. Nothing else may. The order check sits on the
 * tuple, not the object, so interfaces can still `.omit()` a field from this schema.
 */
export const PublicQuestionViewSchema = z.strictObject({
  questionId: z.string().regex(/^q_[0-9a-f]{12}$/),
  /** 1-based position in the session. */
  position: z.number().int().min(1),
  total: z.number().int().min(1),
  stem: z.string(),
  options: z
    .tuple([OptionViewSchema, OptionViewSchema, OptionViewSchema, OptionViewSchema])
    .refine((options) => options.every((o, i) => o.index === i && o.label === LABELS[i]), 'options must be indexed 0-3 in order'),
  /** Absent when the working tree no longer matches the scanned chunk, or when disabled. */
  code: PublicCodePreviewSchema.optional(),
});

export type PublicQuestionView = z.infer<typeof PublicQuestionViewSchema>;

/**
 * Builds a preview from the raw lines of `startLine..` (the whole chunk range), keeping at most
 * `CODE_PREVIEW_MAX_LINES`. Null for an empty slice, which the schema could not describe.
 */
export function codePreview(path: string, startLine: number, language: string, lines: readonly string[]): PublicCodePreview | null {
  if (lines.length === 0 || !Number.isInteger(startLine) || startLine < 1) return null;
  const kept = lines.slice(0, CODE_PREVIEW_MAX_LINES);
  const preview: PublicCodePreview = { path, startLine, endLine: startLine + kept.length - 1, language, text: kept.join('\n') };
  return lines.length > CODE_PREVIEW_MAX_LINES ? { ...preview, truncated: true } : preview;
}

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

// Keys only, never string values: `code.text` is real source and may legitimately say
// `explanation` or `correctIndex` (gotchea's own code does). A key is what would carry a leaked
// field; a word inside a snippet carries nothing.
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
export function toPublicView(
  q: Pick<QuestionPrivate, 'id' | 'stem' | 'options'>,
  perm: Permutation,
  position: number,
  total: number,
  code?: PublicCodePreview | null,
): PublicQuestionView {
  const view: PublicQuestionView = { questionId: q.id, position, total, stem: q.stem, options: display(q, perm) };
  if (!code) return view;
  // Copied field by field, like the question, so an extra key on the argument can't ride along.
  const { path, startLine, endLine, language, text, truncated } = code;
  return { ...view, code: { path, startLine, endLine, language, text, ...(truncated ? { truncated } : {}) } };
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
