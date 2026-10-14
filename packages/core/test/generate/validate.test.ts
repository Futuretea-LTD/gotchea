import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { REJECTION_REASONS, validateBatch, type RejectionReason } from '../../src/generate/validate.js';

// Numbered code the questions refer to (5 lines):
// 1 export function clamp(n: number, lo: number, hi: number): number {
// 2   if (n < lo) return lo;
// 3   if (n > hi) return hi;
// 4   return n;
// 5 }
const N = 5;
const cfg = defaultConfig().questions;

const valid = {
  type: 'behavior',
  stem: 'What does clamp(15, 0, 10) return?',
  options: ['10', '0', '15', 'NaN'],
  correctIndex: 0,
  explanation: 'L3 returns hi when n > hi, so 10. L2 only applies below lo and L4 is never reached.',
  refs: [{ start: 2, end: 4 }],
  difficulty: 1,
};

const run = (items: unknown[], over: Partial<Parameters<typeof validateBatch>[0]> = {}) =>
  validateBatch({ items, chunkLineCount: N, existing: [], cfg, ...over });

const cases: [RejectionReason, Record<string, unknown>, Partial<Parameters<typeof validateBatch>[0]>?][] = [
  ['schema_invalid', { options: ['10', '0', '15'] }],
  ['type_not_allowed', { type: 'purpose' }, { cfg: { ...cfg, types: ['behavior'] } }],
  ['options_not_distinct', { options: ['10', ' 10.', '15', 'NaN'] }],
  ['meta_option', { options: ['10', '0', '15', 'None of the above'] }],
  ['answer_leak_marker', { stem: 'Which is the correct answer for clamp(15, 0, 10)?' }],
  [
    'answer_leak_stem',
    {
      stem: 'For n > hi, clamp returns hi unchanged. Why is that safe here?',
      options: ['returns hi unchanged', 'returns lo instead', 'throws a RangeError', 'returns n as is'],
    },
  ],
  [
    'answer_leak_options',
    { options: ['returns hi', 'returns hi after logging', 'returns lo', 'returns n'], correctIndex: 1 },
  ],
  ['length_skew', { options: ['returns hi because n exceeds the upper bound', 'lo', 'n', 'NaN'] }],
  ['refs_out_of_range', { refs: [{ start: 4, end: 9 }] }],
  ['explanation_citation', { explanation: 'The second guard returns hi for every input above it.' }],
  ['trivia', { stem: 'Which line returns hi when n exceeds the bound?' }],
  ['duplicate_stored', {}, { existing: [{ id: 'q_000000000000', stem: valid.stem }] }],
];

describe('validateBatch', () => {
  it('accepts a well-formed question (shared identifiers in every option are not a leak)', () => {
    const r = run([valid]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.index).toBe(0);
  });

  it.each(cases)('rejects %s', (reason, patch, over) => {
    const item = { ...valid, ...patch };
    const r = run([item], over);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ index: 0, reason });
    // detail never echoes the stem or option text
    const detail = r.rejected[0]!.detail;
    for (const text of [item.stem as string, ...(item.options as string[]).filter((o) => o.length > 3)]) {
      expect(detail).not.toContain(text);
    }
  });

  it('covers every reason code in the table or the batch test', () => {
    expect(new Set([...cases.map(([r]) => r), 'duplicate_batch'])).toEqual(new Set(REJECTION_REASONS));
  });

  it('reports refs and citations outside the chunk', () => {
    expect(run([{ ...valid, refs: [{ start: 0, end: 1 }] }]).rejected[0]!.detail).toBe('ref 0 L0-L1 outside 1..5');
    expect(run([{ ...valid, refs: [{ start: 3, end: 2 }] }]).rejected[0]!.reason).toBe('refs_out_of_range');
    expect(run([{ ...valid, explanation: 'See L999 where the upper guard returns hi.' }]).rejected[0]!.detail).toBe(
      'explanation cites L999 outside 1..5',
    );
  });

  it('length skew ignores short code-token options under the char floor', () => {
    expect(run([{ ...valid, options: ['hi', 'n', 'lo', 'x'] }]).rejected).toEqual([]);
  });

  it('dedupes within the batch against accepted items only', () => {
    const r = run([{ ...valid, options: ['10', '10', '15', 'NaN'] }, valid, valid]);
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([
      [0, 'options_not_distinct'],
      [2, 'duplicate_batch'],
    ]);
    expect(r.rejected[1]!.detail).toMatch(/^near-duplicate of item 1 \(J=1\.00\)$/);
    expect(r.accepted.map((a) => a.index)).toEqual([1]);
  });

  it('reports the first failing rule only (leak before length skew)', () => {
    const r = run([
      {
        ...valid,
        stem: 'Why does clamp return hi because n exceeds the upper bound here?',
        options: ['return hi because n exceeds the upper bound', 'lo', '0', 'NaN'],
      },
    ]);
    expect(r.rejected[0]!.reason).toBe('answer_leak_stem');
  });
});

// ---------------------------------------------------------------------------
// Boundary table: for every reason code, cases just past and just inside the rule.
// ---------------------------------------------------------------------------

/** Options with similar length and form; `the upper bound hi` (index 0) is correct. */
const phrased = { ...valid, options: ['the upper bound hi', 'the lower bound lo', 'the input n as is', 'NaN for any input'] };

/** `<letter> xxxx…` of exactly `len` chars: no content words shared with the stem, no substrings of each other. */
const filler = (letter: string, len: number) => `${letter} ${'x'.repeat(len)}`.slice(0, len);
/** Correct option (index 0) of `correctLen` chars against three distractors of `distractorLen` chars. */
const lengths = (correctLen: number, distractorLen: number) => ({
  ...valid,
  options: [filler('a', correctLen), filler('b', distractorLen), filler('c', distractorLen), filler('d', distractorLen)],
});

type Over = Partial<Parameters<typeof validateBatch>[0]>;
type Expected = RejectionReason | 'accepted';
const outcome = (item: unknown, over?: Over): Expected => {
  const r = run([item], over);
  return r.rejected[0]?.reason ?? (r.accepted.length === 1 ? 'accepted' : (() => { throw new Error('no outcome'); })());
};

const boundaries: [name: string, item: unknown, over: Over | undefined, expected: Expected][] = [
  // 1 schema_invalid
  ['schema: 3 options', { ...valid, options: ['10', '0', '15'] }, undefined, 'schema_invalid'],
  ['schema: 5 options', { ...valid, options: ['10', '0', '15', 'NaN', '-1'] }, undefined, 'schema_invalid'],
  ['schema: stem of 9 chars (after trim)', { ...valid, stem: '   clamp(1)?   ' }, undefined, 'schema_invalid'],
  ['schema: stem of exactly 10 chars', { ...valid, stem: 'clamp(15)?' }, undefined, 'accepted'],
  ['schema: explanation of 19 chars', { ...valid, explanation: 'L3 returns hi so 10' }, undefined, 'schema_invalid'],
  ['schema: explanation of exactly 20 chars', { ...valid, explanation: 'L3 returns hi so 10.' }, undefined, 'accepted'],
  ['schema: empty option', { ...valid, options: ['10', '  ', '15', 'NaN'] }, undefined, 'schema_invalid'],
  [
    'schema: option of 301 chars',
    { ...valid, options: ['a', 'b', 'c', 'd'].map((l) => filler(l, 301)) },
    undefined,
    'schema_invalid',
  ],
  ['schema: options of exactly 300 chars', { ...valid, options: ['a', 'b', 'c', 'd'].map((l) => filler(l, 300)) }, undefined, 'accepted'],
  ['schema: correctIndex 4', { ...valid, correctIndex: 4 }, undefined, 'schema_invalid'],
  ['schema: correctIndex -1', { ...valid, correctIndex: -1 }, undefined, 'schema_invalid'],
  ['schema: correctIndex 1.5', { ...valid, correctIndex: 1.5 }, undefined, 'schema_invalid'],
  ['schema: correctIndex 3 (upper bound)', { ...valid, options: ['0', '15', 'NaN', '10'], correctIndex: 3 }, undefined, 'accepted'],
  ['schema: no refs', { ...valid, refs: [] }, undefined, 'schema_invalid'],
  ['schema: 6 refs', { ...valid, refs: Array.from({ length: 6 }, () => ({ start: 1, end: 1 })) }, undefined, 'schema_invalid'],
  ['schema: exactly 5 refs', { ...valid, refs: Array.from({ length: 5 }, (_, i) => ({ start: i + 1, end: i + 1 })) }, undefined, 'accepted'],
  ['schema: non-integer ref', { ...valid, refs: [{ start: 1.5, end: 2 }] }, undefined, 'schema_invalid'],
  ['schema: difficulty 0', { ...valid, difficulty: 0 }, undefined, 'schema_invalid'],
  ['schema: difficulty 4', { ...valid, difficulty: 4 }, undefined, 'schema_invalid'],
  ['schema: difficulty 3', { ...valid, difficulty: 3 }, undefined, 'accepted'],
  ['schema: unknown type', { ...valid, type: 'trivia' }, undefined, 'schema_invalid'],
  ['schema: extra key (server-stamped field)', { ...valid, id: 'q_000000000000' }, undefined, 'schema_invalid'],
  ['schema: missing key', (({ difficulty: _d, ...rest }) => rest)(valid), undefined, 'schema_invalid'],
  ['schema: null item', null, undefined, 'schema_invalid'],
  ['schema: string item', 'What does clamp return?', undefined, 'schema_invalid'],

  // 2 type_not_allowed
  ['type: disabled in config', { ...valid, type: 'purpose' }, { cfg: { ...cfg, types: ['behavior'] } }, 'type_not_allowed'],
  ['type: the one enabled type', { ...valid, type: 'behavior' }, { cfg: { ...cfg, types: ['behavior'] } }, 'accepted'],

  // 3 options_not_distinct (normalised equality only)
  ['distinct: equal after normalisation', { ...valid, options: ['10', ' 10.', '15', 'NaN'] }, undefined, 'options_not_distinct'],
  ['distinct: equal up to case and backticks', { ...valid, options: ['10', '`nan`', '15', 'NaN'] }, undefined, 'options_not_distinct'],
  ['distinct: differ by one character', { ...valid, options: ['10', '-10', '15', 'NaN'] }, undefined, 'accepted'],

  // 4 meta_option
  ['meta: none of the above', { ...phrased, options: [...phrased.options.slice(0, 3), 'none of the above'] }, undefined, 'meta_option'],
  ['meta: both A and B', { ...phrased, options: [...phrased.options.slice(0, 3), 'Both A and B'] }, undefined, 'meta_option'],
  ['meta: letter reference', { ...phrased, options: [...phrased.options.slice(0, 3), 'same as option C'] }, undefined, 'meta_option'],
  ['meta: tr hepsi', { ...phrased, options: [...phrased.options.slice(0, 3), 'Hepsi doğrudur'] }, undefined, 'meta_option'],
  ['meta: "none of the bounds" is not meta', { ...phrased, options: [...phrased.options.slice(0, 3), 'none of the bounds'] }, undefined, 'accepted'],
  ['meta: "optional a" is not a letter reference', { ...phrased, options: [...phrased.options.slice(0, 3), 'an optional arg'] }, undefined, 'accepted'],

  // 5 answer_leak_marker
  ['marker: correct answer', { ...valid, stem: 'Which is the correct answer for clamp(15, 0, 10)?' }, undefined, 'answer_leak_marker'],
  ['marker: answer:', { ...valid, stem: 'clamp(15, 0, 10) gives what? Answer: see below' }, undefined, 'answer_leak_marker'],
  ['marker: trailing (b)', { ...valid, stem: 'What does clamp(15, 0, 10) return? (b)' }, undefined, 'answer_leak_marker'],
  ['marker: tr doğru cevap', { ...valid, stem: 'clamp(15, 0, 10) için doğru cevap hangisi?' }, undefined, 'answer_leak_marker'],
  ['marker: "right bound" is not a marker', { ...valid, stem: 'What does clamp(15, 0, 10) return at the right bound?' }, undefined, 'accepted'],
  ['marker: "(b)" mid-stem is not a marker', { ...valid, stem: 'With hi as (b) here, what does clamp(15, 0, 10) return?' }, undefined, 'accepted'],

  // 6 answer_leak_stem
  [
    'stem leak (a): correct option of 4 chars verbatim, no distractor in the stem',
    { ...valid, stem: 'What does clamp return when n+lo exceeds hi?', options: ['n+lo', 'n-lo', 'hi+lo', 'lo-hi'] },
    undefined,
    'answer_leak_stem',
  ],
  [
    'stem leak (a): 3 chars is under the verbatim floor',
    { ...valid, stem: 'What does clamp return when n+1 exceeds hi?', options: ['n+1', 'n-1', 'hi+1', 'lo-1'] },
    undefined,
    'accepted',
  ],
  [
    'stem leak (a): a distractor is in the stem too',
    { ...phrased, stem: 'Does clamp(15, 0, 10) return the upper bound hi or the lower bound lo?' },
    undefined,
    'accepted',
  ],
  [
    'stem leak (b): 60% of the correct option’s content words',
    {
      ...valid,
      stem: 'What happens to a value beyond the upper bound passed to clamp?',
      options: ['caps large value at upper bound', 'drops small input below zero', 'throws range error for input', 'wraps around to lower limit'],
    },
    undefined,
    'answer_leak_stem',
  ],
  [
    'stem leak (b): the same item under a 61% limit',
    {
      ...valid,
      stem: 'What happens to a value beyond the upper bound passed to clamp?',
      options: ['caps large value at upper bound', 'drops small input below zero', 'throws range error for input', 'wraps around to lower limit'],
    },
    { cfg: { ...cfg, leakWordOverlap: 0.61 } },
    'accepted',
  ],
  [
    'stem leak (b): margin of exactly 0.25 over the best distractor',
    {
      ...valid,
      stem: 'When the value hits clamp, what happens at the upper bound?',
      options: ['value hits upper bound', 'value hits lower bound', 'value skips upper check', 'input wraps around zero'],
    },
    undefined,
    'answer_leak_stem',
  ],
  [
    'stem leak (b): the same item under a 0.26 margin',
    {
      ...valid,
      stem: 'When the value hits clamp, what happens at the upper bound?',
      options: ['value hits upper bound', 'value hits lower bound', 'value skips upper check', 'input wraps around zero'],
    },
    { cfg: { ...cfg, leakMargin: 0.26 } },
    'accepted',
  ],
  [
    'stem leak (b): lo/hi/n/NaN, shared identifiers do not discriminate',
    { ...valid, stem: 'Which value does clamp return for n > hi?', options: ['hi', 'lo', 'n', 'NaN'] },
    undefined,
    'accepted',
  ],

  // 7 answer_leak_options
  ['options leak (a): correct extends a 4-char distractor', { ...valid, options: ['hi+10', 'hi+1', 'lo-5', 'n*2'] }, undefined, 'answer_leak_options'],
  ['options leak (a): a 3-char distractor inside the correct one is allowed', { ...valid, options: ['lo+10', '+10', 'hi+5', 'lo-5'] }, undefined, 'accepted'],
  [
    'options leak (b): near-identical distractors, odd correct option',
    {
      ...valid,
      options: ['throws a RangeError instead', 'returns the lower bound value', 'returns the lower bound values', 'returns the lower bounds value'],
    },
    undefined,
    'answer_leak_options',
  ],
  [
    'options leak (b): one distractor pair under J 0.8',
    {
      ...valid,
      options: ['throws a RangeError instead', 'returns the lower bound value', 'returns the lower bound values', 'returns the lowest bound value'],
    },
    undefined,
    'accepted',
  ],
  [
    'options leak (b): correct option close to the distractors',
    {
      ...valid,
      options: ['returns the upper bound value', 'returns the lower bound value', 'returns the lower bound values', 'returns the lower bounds value'],
    },
    undefined,
    'accepted',
  ],

  // 8 length_skew (distractors 100 chars: allowed ratio 0.714–1.4)
  ['length: r = 1.41', lengths(141, 100), undefined, 'length_skew'],
  ['length: r = 1.40 (limit)', lengths(140, 100), undefined, 'accepted'],
  ['length: r = 1.39', lengths(139, 100), undefined, 'accepted'],
  ['length: r = 0.71', lengths(71, 100), undefined, 'length_skew'],
  ['length: r = 0.72', lengths(72, 100), undefined, 'accepted'],
  ['length: long side, 8 chars over the mean (floor)', lengths(18, 10), undefined, 'accepted'],
  ['length: long side, 9 chars over the mean', lengths(19, 10), undefined, 'length_skew'],
  ['length: short side, 8 chars under the mean (floor)', lengths(12, 20), undefined, 'accepted'],
  ['length: short side, 9 chars under the mean', lengths(11, 20), undefined, 'length_skew'],

  // 9 refs_out_of_range (chunk-relative 1..N, N = 5)
  ['refs: start 0', { ...valid, refs: [{ start: 0, end: 2 }] }, undefined, 'refs_out_of_range'],
  ['refs: negative', { ...valid, refs: [{ start: -1, end: 2 }] }, undefined, 'refs_out_of_range'],
  ['refs: end N+1', { ...valid, refs: [{ start: 4, end: 6 }] }, undefined, 'refs_out_of_range'],
  ['refs: start and end N+1', { ...valid, refs: [{ start: 6, end: 6 }] }, undefined, 'refs_out_of_range'],
  ['refs: start > end', { ...valid, refs: [{ start: 3, end: 2 }] }, undefined, 'refs_out_of_range'],
  ['refs: second ref bad', { ...valid, refs: [{ start: 1, end: 1 }, { start: 5, end: 6 }] }, undefined, 'refs_out_of_range'],
  ['refs: L1-L1 (lower bound)', { ...valid, refs: [{ start: 1, end: 1 }] }, undefined, 'accepted'],
  ['refs: L5-L5 (upper bound)', { ...valid, refs: [{ start: 5, end: 5 }] }, undefined, 'accepted'],
  ['refs: L1-L5 (whole chunk)', { ...valid, refs: [{ start: 1, end: 5 }] }, undefined, 'accepted'],
  ['refs: L6 is fine in a 6-line chunk', { ...valid, refs: [{ start: 6, end: 6 }] }, { chunkLineCount: 6 }, 'accepted'],

  // 10 explanation_citation
  ['citation: none', { ...valid, explanation: 'The second guard returns hi for every input above it.' }, undefined, 'explanation_citation'],
  ['citation: lowercase l3 is not a citation', { ...valid, explanation: 'See l3: the upper guard returns hi.' }, undefined, 'explanation_citation'],
  ['citation: L0', { ...valid, explanation: 'L0 is not code; the upper guard returns hi.' }, undefined, 'explanation_citation'],
  ['citation: L6 (N+1)', { ...valid, explanation: 'L6 returns hi when n exceeds the bound.' }, undefined, 'explanation_citation'],
  ['citation: range ending at N+1', { ...valid, explanation: 'L4-L6 return hi when n exceeds the bound.' }, undefined, 'explanation_citation'],
  ['citation: short range ending at N+1', { ...valid, explanation: 'L4–6 return hi when n exceeds the bound.' }, undefined, 'explanation_citation'],
  ['citation: L1 and L5', { ...valid, explanation: 'L1 declares hi; L5 closes; L3 returns hi.' }, undefined, 'accepted'],
  ['citation: L1-L5', { ...valid, explanation: 'L1-L5 together return hi for n > hi.' }, undefined, 'accepted'],
  ['citation: L4–5 (en dash, short form)', { ...valid, explanation: 'L4–5 are skipped because L3 returns hi.' }, undefined, 'accepted'],

  // 11 trivia
  ['trivia: which line', { ...valid, stem: 'Which line returns hi when n exceeds the bound?' }, undefined, 'trivia'],
  ['trivia: line number', { ...valid, stem: 'At what line number does clamp return hi?' }, undefined, 'trivia'],
  ['trivia: how many parameters', { ...valid, stem: 'How many parameters does clamp take here?' }, undefined, 'trivia'],
  ['trivia: name of the function', { ...valid, stem: 'What is the name of the function in this chunk?' }, undefined, 'trivia'],
  ['trivia: which file', { ...valid, stem: 'Which file defines clamp in this repo?' }, undefined, 'trivia'],
  ['trivia: tr satır numarası', { ...valid, stem: 'hi hangi satır numarası ile döner?' }, undefined, 'trivia'],
  ['trivia: "what does the line … guard" is about behaviour', { ...valid, stem: 'What does the line with n > hi guard against?' }, undefined, 'accepted'],
  ['trivia: "how many times" is not a count of lines/params', { ...valid, stem: 'How many times is hi compared for clamp(15, 0, 10)?' }, undefined, 'accepted'],

  // 12 duplicate_stored (trigram Jaccard of the stems, threshold 0.8)
  ['dup stored: J = 0.82', valid, { existing: [{ id: 'q_aaaaaaaaaaaa', stem: 'What does clamp(16, 0, 10) return?' }] }, 'duplicate_stored'],
  ['dup stored: J = 0.79', valid, { existing: [{ id: 'q_aaaaaaaaaaaa', stem: 'What does clamp(15, 0, 9) return?' }] }, 'accepted'],
];

describe('validateBatch boundaries', () => {
  it.each(boundaries)('%s', (_name, item, over, expected) => {
    expect(outcome(item, over)).toBe(expected);
  });

  it('every reason code has a failing and a passing row in the table or the batch tests', () => {
    const failing = new Set(boundaries.map(([, , , e]) => e).filter((e) => e !== 'accepted'));
    expect(new Set([...failing, 'duplicate_batch'])).toEqual(new Set(REJECTION_REASONS));
    expect(boundaries.filter(([, , , e]) => e === 'accepted').length).toBeGreaterThanOrEqual(REJECTION_REASONS.length - 1);
  });

  it('rejection details never quote the stem or any option', () => {
    for (const [name, item, over, expected] of boundaries) {
      if (expected === 'accepted' || typeof item !== 'object' || item === null) continue;
      const q = item as { stem?: unknown; options?: unknown };
      const detail = run([item], over).rejected[0]!.detail;
      const texts = [q.stem, ...(Array.isArray(q.options) ? q.options : [])].filter((t): t is string => typeof t === 'string');
      for (const t of texts.map((s) => s.trim()).filter((s) => s.length > 3)) expect(detail, name).not.toContain(t);
    }
  });

  it('details follow the fixed templates', () => {
    const detail = (item: unknown, over?: Over) => run([item], over).rejected[0]!.detail;
    expect(detail({ ...valid, options: ['10', '0', '15'] })).toMatch(/^options: /);
    expect(detail(null)).toMatch(/^question: /);
    expect(detail({ ...valid, type: 'purpose' }, { cfg: { ...cfg, types: ['behavior'] } })).toBe('type purpose is disabled in config');
    expect(detail({ ...valid, options: ['10', '0', '15', '10.'] })).toBe('options 0 and 3 are identical');
    expect(detail({ ...phrased, options: [...phrased.options.slice(0, 3), 'none of the above'] })).toBe('option 3 refers to other options');
    expect(detail({ ...valid, stem: 'Which is the correct answer for clamp(15, 0, 10)?' })).toBe('stem names the answer');
    expect(detail(boundaries.find(([n]) => n.startsWith('stem leak (a): correct'))![1])).toBe('stem contains the correct option verbatim');
    expect(detail(boundaries.find(([n]) => n.startsWith('stem leak (b): 60%'))![1])).toBe("stem contains 60% of the correct option's content words (max 60%)");
    expect(detail({ ...valid, options: ['hi+10', 'hi+1', 'lo-5', 'n*2'] })).toBe('correct option extends a distractor');
    expect(detail(boundaries.find(([n]) => n.startsWith('options leak (b): near'))![1])).toBe(
      'distractors are near-identical; correct option is the odd one out',
    );
    expect(detail(lengths(141, 100))).toBe('correct option is 1.41x the mean distractor length (allowed 0.71–1.4)');
    expect(detail(lengths(71, 100))).toBe('correct option is 0.71x the mean distractor length (allowed 0.71–1.4)');
    expect(detail({ ...valid, refs: [{ start: 1, end: 1 }, { start: 5, end: 6 }] })).toBe('ref 1 L5-L6 outside 1..5');
    expect(detail({ ...valid, refs: [{ start: 6, end: 6 }] })).toBe('ref 0 L6-L6 outside 1..5');
    expect(detail({ ...valid, explanation: 'L0 is not code; the upper guard returns hi.' })).toBe('explanation cites L0 outside 1..5');
    expect(detail({ ...valid, explanation: 'L4-L6 return hi when n exceeds the bound.' })).toBe('explanation cites L6 outside 1..5');
    expect(detail({ ...valid, stem: 'How many parameters does clamp take here?' })).toBe('stem asks for trivia (how-many)');
    expect(detail(valid, { existing: [{ id: 'q_aaaaaaaaaaaa', stem: 'What does clamp(16, 0, 10) return?' }] })).toBe(
      'near-duplicate of stored question q_aaaaaaaaaaaa (J=0.82)',
    );
  });

  it('refs are chunk-relative: the same ref is valid or not depending only on chunkLineCount', () => {
    const item = { ...valid, refs: [{ start: 1, end: 6 }], explanation: 'L6 closes; L3 returns hi when n > hi.' };
    expect(outcome(item, { chunkLineCount: 5 })).toBe('refs_out_of_range');
    expect(outcome(item, { chunkLineCount: 6 })).toBe('accepted');
    // A one-line chunk accepts only L1.
    expect(outcome({ ...valid, refs: [{ start: 1, end: 1 }], explanation: 'L1 returns hi when n > hi.' }, { chunkLineCount: 1 })).toBe('accepted');
    expect(outcome({ ...valid, refs: [{ start: 1, end: 2 }], explanation: 'L1 returns hi when n > hi.' }, { chunkLineCount: 1 })).toBe(
      'refs_out_of_range',
    );
  });

  it('rule order: schema first, refs before citations, stored before batch duplicates', () => {
    // A schema failure wins over everything else the item breaks.
    expect(outcome({ ...valid, stem: 'Which line?', options: ['10', '10', '15'] })).toBe('schema_invalid');
    // Bad refs and a bad citation: refs (9) is reported, not the citation (10).
    expect(outcome({ ...valid, refs: [{ start: 0, end: 1 }], explanation: 'L9 returns hi when n exceeds hi.' })).toBe('refs_out_of_range');
    // Trivia (11) after everything item-local.
    expect(outcome({ ...valid, stem: 'Which line returns hi?', refs: [{ start: 9, end: 9 }] })).toBe('refs_out_of_range');
    // An item that duplicates both a stored stem and an earlier batch item reports the stored one.
    const r = run([valid, valid], { existing: [{ id: 'q_aaaaaaaaaaaa', stem: valid.stem }] });
    expect(r.rejected.map((x) => x.reason)).toEqual(['duplicate_stored', 'duplicate_stored']);
  });
});

describe('validateBatch near-duplicates within the batch', () => {
  it('rejects a paraphrase (J ≥ 0.8) of an earlier accepted item with its index', () => {
    const r = run([valid, { ...valid, stem: 'What does clamp(16, 0, 10) return?' }]);
    expect(r.accepted.map((a) => a.index)).toEqual([0]);
    expect(r.rejected).toEqual([{ index: 1, reason: 'duplicate_batch', detail: 'near-duplicate of item 0 (J=0.82)' }]);
  });

  it('keeps a stem just under the threshold (J = 0.79)', () => {
    const r = run([valid, { ...valid, stem: 'What does clamp(15, 0, 9) return?' }]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((a) => a.index)).toEqual([0, 1]);
  });

  it('honours a configured threshold', () => {
    const second = { ...valid, stem: 'What does clamp(15, 0, 9) return?' };
    expect(run([valid, second], { cfg: { ...cfg, dedupeJaccard: 0.79 } }).rejected.map((x) => x.reason)).toEqual(['duplicate_batch']);
  });

  it('a later item is compared with accepted items only, not with a rejected near-duplicate', () => {
    const items = [
      { ...valid, stem: 'What does clamp(25, 0, 10) return?' },
      valid,
      { ...valid, stem: 'So what does clamp(15, 0, 10) return?' },
    ];
    const r = run(items);
    // item 1 vs item 0: J = 0.82 → rejected. item 2 is J = 0.91 to item 1 but under 0.8 to item 0 → accepted.
    expect(r.rejected).toEqual([{ index: 1, reason: 'duplicate_batch', detail: 'near-duplicate of item 0 (J=0.82)' }]);
    expect(r.accepted.map((a) => a.index)).toEqual([0, 2]);
  });

  it('a stored duplicate never enters the batch pool', () => {
    const stored = [{ id: 'q_aaaaaaaaaaaa', stem: 'What does clamp(16, 0, 10) return?' }];
    // item 0 is a stored duplicate; item 1 (J = 0.79 to the stored stem, 1.0 to item 0) must not be blocked by item 0.
    const r = run([valid, { ...valid, stem: 'What does clamp(16, 0, 9) return?' }], { existing: stored });
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([[0, 'duplicate_stored']]);
    expect(r.accepted.map((a) => a.index)).toEqual([1]);
  });
});

describe('validateBatch accept path', () => {
  it('accepts a whole valid batch in order and returns the parsed (trimmed) questions', () => {
    const items = [
      { ...valid, stem: '  What does clamp(15, 0, 10) return?  ', options: [' 10 ', '0', '15', 'NaN'] },
      { ...phrased, type: 'edge_case', stem: 'Which value comes back when n equals hi exactly?', difficulty: 2 },
      {
        ...valid,
        type: 'bug_detection',
        stem: 'If the guard on L2 used <= instead of <, what would clamp(0, 0, 10) return?',
        options: ['still 0', 'NaN', '10', 'undefined'],
        refs: [{ start: 2, end: 2 }],
        explanation: 'L2 would return lo, which is 0 as well, so the output is unchanged.',
        difficulty: 3,
      },
    ];
    const r = run(items);
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((a) => a.index)).toEqual([0, 1, 2]);
    expect(r.accepted[0]!.question.stem).toBe('What does clamp(15, 0, 10) return?');
    expect(r.accepted[0]!.question.options).toEqual(['10', '0', '15', 'NaN']);
    expect(r.accepted[2]!.question).toEqual({ ...items[2], refs: [{ start: 2, end: 2 }] });
    // Only the raw fields come back; nothing is stamped by the validator.
    for (const a of r.accepted) expect(Object.keys(a.question).sort()).toEqual(Object.keys(valid).sort());
  });

  it('mixes accepted and rejected items with stable indices', () => {
    const r = run([valid, { ...valid, refs: [{ start: 0, end: 0 }] }, { ...phrased, stem: 'Which value comes back when n equals hi exactly?' }, null]);
    expect(r.accepted.map((a) => a.index)).toEqual([0, 2]);
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([
      [1, 'refs_out_of_range'],
      [3, 'schema_invalid'],
    ]);
  });

  it('an empty batch yields nothing', () => {
    expect(run([])).toEqual({ accepted: [], rejected: [] });
  });
});
