// Batch validator for raw questions (M2_DESIGN.md §4). Pure: rules run per item in
// table order and the first failing rule rejects it. `detail` strings follow fixed
// templates and never quote option text, the stem or the answer key.
import type { QuestionsConfig } from '../config/schema.js';
import { jaccard, trigrams } from './dedupe.js';
import { RawQuestionSchema, type RawQuestion } from './schema.js';
import { citations, normalizeText, overlap } from './text.js';

export const REJECTION_REASONS = [
  'schema_invalid',
  'type_not_allowed',
  'options_not_distinct',
  'meta_option',
  'answer_leak_marker',
  'answer_leak_stem',
  'answer_leak_options',
  'length_skew',
  'refs_out_of_range',
  'explanation_citation',
  'trivia',
  'duplicate_stored',
  'duplicate_batch',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type ValidatorConfig = Pick<
  QuestionsConfig,
  'types' | 'leakWordOverlap' | 'leakMargin' | 'maxCorrectLengthRatio' | 'lengthSkewMinChars' | 'dedupeJaccard'
>;

export interface ValidateInput {
  /** Raw batch items. */
  items: readonly unknown[];
  /** Line count of the chunk's numbered code; refs and citations must stay in 1..N. */
  chunkLineCount: number;
  /** Usable + flagged questions of this chunk at the current hash (stems are public). */
  existing: readonly { id: string; stem: string }[];
  cfg: ValidatorConfig;
}

export interface Rejection {
  index: number;
  reason: RejectionReason;
  detail: string;
}

export interface ValidationResult {
  accepted: { index: number; question: RawQuestion }[];
  rejected: Rejection[];
}

type Failure = { reason: RejectionReason; detail: string };

const META_OPTION = [
  /\b(all|none|both|neither) of the (above|options)\b/i,
  /^(both|neither) [a-d] (and|nor) [a-d]$/i,
  /\boption [a-d]\b/i,
  /hepsi|hiçbiri|yukarıdakiler/i,
];

const LEAK_MARKERS = [/\b(correct|right|true) (answer|option|choice)\b/i, /\banswer\s*[:=]/i, /\(\s*[a-d]\s*\)\s*$/i, /doğru (cevap|yanıt|seçenek)/i];

const TRIVIA: [id: string, re: RegExp][] = [
  ['which-line', /\b(which|what) line\b/i],
  ['line-number', /\bline number/i],
  ['how-many', /\bhow many (lines|characters|parameters|arguments|imports)\b/i],
  ['name-of', /\bwhat is the name of the (function|method|variable|class|file|module)\b/i],
  ['which-file', /\bwhich file\b/i],
  ['tr', /kaçıncı satır|satır numarası|adı nedir/i],
];

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fixed2 = (x: number): string => x.toFixed(2);

export function validateBatch(input: ValidateInput): ValidationResult {
  const { cfg, chunkLineCount } = input;
  const stored = input.existing.map((e) => ({ id: e.id, grams: trigrams(e.stem) }));
  const batch: { index: number; grams: Set<string> }[] = [];
  const result: ValidationResult = { accepted: [], rejected: [] };

  input.items.forEach((item, index) => {
    const parsed = RawQuestionSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'question';
      result.rejected.push({ index, reason: 'schema_invalid', detail: `${path}: ${issue?.message ?? 'invalid'}` });
      return;
    }
    const q = parsed.data;
    const grams = trigrams(q.stem);
    const failure = checkQuestion(q, chunkLineCount, cfg) ?? checkDuplicates(grams, stored, batch, cfg.dedupeJaccard);
    if (failure) {
      result.rejected.push({ index, ...failure });
      return;
    }
    batch.push({ index, grams });
    result.accepted.push({ index, question: q });
  });
  return result;
}

/** Rules 2–11: everything that depends on the item alone. */
function checkQuestion(q: RawQuestion, chunkLineCount: number, cfg: ValidatorConfig): Failure | null {
  if (!cfg.types.includes(q.type)) return { reason: 'type_not_allowed', detail: `type ${q.type} is disabled in config` };

  const norm = q.options.map(normalizeText);
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      if (norm[i] === norm[j]) return { reason: 'options_not_distinct', detail: `options ${i} and ${j} are identical` };
    }
  }

  const meta = q.options.findIndex((o) => META_OPTION.some((re) => re.test(o)));
  if (meta >= 0) return { reason: 'meta_option', detail: `option ${meta} refers to other options` };

  if (LEAK_MARKERS.some((re) => re.test(q.stem))) return { reason: 'answer_leak_marker', detail: 'stem names the answer' };

  const correct = q.options[q.correctIndex];
  const distractors = q.options.filter((_, i) => i !== q.correctIndex);
  const nStem = normalizeText(q.stem);
  const nCorrect = normalizeText(correct);
  const nDistractors = distractors.map(normalizeText);

  return (
    stemLeak(q.stem, nStem, correct, nCorrect, distractors, nDistractors, cfg) ??
    optionsLeak(nCorrect, nDistractors) ??
    lengthSkew(nCorrect, nDistractors, cfg) ??
    refsRange(q, chunkLineCount) ??
    citationRange(q.explanation, chunkLineCount) ??
    trivia(q.stem)
  );
}

function stemLeak(
  stem: string,
  nStem: string,
  correct: string,
  nCorrect: string,
  distractors: readonly string[],
  nDistractors: readonly string[],
  cfg: ValidatorConfig,
): Failure | null {
  if (nCorrect.length >= 4 && nStem.includes(nCorrect) && !nDistractors.some((d) => d.length > 0 && nStem.includes(d))) {
    return { reason: 'answer_leak_stem', detail: 'stem contains the correct option verbatim' };
  }
  const oc = overlap(correct, stem);
  const od = Math.max(...distractors.map((d) => overlap(d, stem)));
  if (oc >= cfg.leakWordOverlap && oc - od >= cfg.leakMargin) {
    return {
      reason: 'answer_leak_stem',
      detail: `stem contains ${pct(oc)} of the correct option's content words (max ${pct(cfg.leakWordOverlap)})`,
    };
  }
  return null;
}

function optionsLeak(nCorrect: string, nDistractors: readonly string[]): Failure | null {
  if (nDistractors.some((d) => d.length >= 4 && d !== nCorrect && nCorrect.includes(d))) {
    return { reason: 'answer_leak_options', detail: 'correct option extends a distractor' };
  }
  const dGrams = nDistractors.map((d) => trigrams(d));
  const cGrams = trigrams(nCorrect);
  let distractorsAlike = true;
  for (let i = 0; i < dGrams.length && distractorsAlike; i++) {
    for (let j = i + 1; j < dGrams.length; j++) {
      if (jaccard(dGrams[i]!, dGrams[j]!) < 0.8) {
        distractorsAlike = false;
        break;
      }
    }
  }
  if (distractorsAlike && dGrams.every((d) => jaccard(cGrams, d) < 0.5)) {
    return { reason: 'answer_leak_options', detail: 'distractors are near-identical; correct option is the odd one out' };
  }
  return null;
}

function lengthSkew(nCorrect: string, nDistractors: readonly string[], cfg: ValidatorConfig): Failure | null {
  const mean = nDistractors.reduce((s, d) => s + d.length, 0) / nDistractors.length;
  const r = nCorrect.length / Math.max(mean, 1);
  const max = cfg.maxCorrectLengthRatio;
  if ((r > max || r < 1 / max) && Math.abs(nCorrect.length - mean) > cfg.lengthSkewMinChars) {
    return {
      reason: 'length_skew',
      detail: `correct option is ${fixed2(r)}x the mean distractor length (allowed ${fixed2(1 / max)}–${max})`,
    };
  }
  return null;
}

function refsRange(q: RawQuestion, n: number): Failure | null {
  const k = q.refs.findIndex((r) => r.start < 1 || r.end < r.start || r.end > n);
  if (k < 0) return null;
  const r = q.refs[k]!;
  return { reason: 'refs_out_of_range', detail: `ref ${k} L${r.start}-L${r.end} outside 1..${n}` };
}

function citationRange(explanation: string, n: number): Failure | null {
  const cited = citations(explanation);
  if (cited.length === 0) return { reason: 'explanation_citation', detail: 'explanation cites no line' };
  for (const c of cited) {
    for (const line of [c.start, c.end]) {
      if (line < 1 || line > n) return { reason: 'explanation_citation', detail: `explanation cites L${line} outside 1..${n}` };
    }
  }
  return null;
}

function trivia(stem: string): Failure | null {
  const hit = TRIVIA.find(([, re]) => re.test(stem));
  return hit ? { reason: 'trivia', detail: `stem asks for trivia (${hit[0]})` } : null;
}

/** Rules 12–13: near-duplicate stems against the stored pool, then against earlier accepted items. */
function checkDuplicates(
  grams: ReadonlySet<string>,
  stored: readonly { id: string; grams: ReadonlySet<string> }[],
  batch: readonly { index: number; grams: ReadonlySet<string> }[],
  threshold: number,
): Failure | null {
  const s = closest(grams, stored);
  if (s && s.j >= threshold) {
    return { reason: 'duplicate_stored', detail: `near-duplicate of stored question ${s.item.id} (J=${fixed2(s.j)})` };
  }
  const b = closest(grams, batch);
  if (b && b.j >= threshold) return { reason: 'duplicate_batch', detail: `near-duplicate of item ${b.item.index} (J=${fixed2(b.j)})` };
  return null;
}

function closest<T extends { grams: ReadonlySet<string> }>(grams: ReadonlySet<string>, pool: readonly T[]): { item: T; j: number } | null {
  let best: { item: T; j: number } | null = null;
  for (const item of pool) {
    const j = jaccard(grams, item.grams);
    if (!best || j > best.j) best = { item, j };
  }
  return best;
}
