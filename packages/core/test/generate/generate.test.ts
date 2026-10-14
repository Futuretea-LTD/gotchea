import { describe, expect, it } from 'vitest';
import { numberChunkCode, toAbsoluteLine } from '../../src/generate/chunk-code.js';
import { PROMPT_VERSION, buildGenerationPrompt, renderHostInstructions } from '../../src/generate/prompt.js';
import { RAW_BATCH_JSON_SCHEMA, RawQuestionSchema, StoredQuestionSchema } from '../../src/generate/schema.js';
import { questionId, stampQuestion } from '../../src/generate/stamp.js';
import { planQuestionTypes } from '../../src/generate/tasks.js';
import { blindVerify, optionPermutation, type VerifyRequest } from '../../src/generate/verify.js';

const raw = RawQuestionSchema.parse({
  type: 'behavior',
  stem: 'What does clamp(15, 0, 10) return?',
  options: ['10', '0', '15', 'NaN'],
  correctIndex: 0,
  explanation: 'L3 returns hi when n > hi, so 10.',
  refs: [{ start: 3, end: 3 }],
  difficulty: 1,
});

describe('schema', () => {
  it('provider JSON Schema has the same properties as RawQuestionSchema', () => {
    const item = RAW_BATCH_JSON_SCHEMA.properties.questions.items;
    expect(Object.keys(item.properties).sort()).toEqual(Object.keys(RawQuestionSchema.shape).sort());
    expect([...item.required].sort()).toEqual(Object.keys(RawQuestionSchema.shape).sort());
  });

  it('stamping yields a valid stored question with a deterministic id', () => {
    const meta = { chunkId: 'src/math.ts#clamp', chunkHash: 'abc', chunkLines: 5, lang: 'pt-BR', generatedBy: 'host:test', now: new Date(0) };
    const q = stampQuestion(raw, meta);
    expect(StoredQuestionSchema.parse(q)).toEqual(q);
    expect(q).toMatchObject({ status: 'ok', flagged: false, verifiedBy: null, promptVersion: PROMPT_VERSION });
    expect(q.id).toBe(questionId('src/math.ts#clamp', 'abc', '  what does clamp(15, 0, 10) RETURN '));
    expect(q.id).not.toBe(questionId('src/math.ts#clamp', 'other', raw.stem));
  });
});

describe('chunk-relative numbering', () => {
  it('numbers from 1 across ranges with an unnumbered separator', () => {
    const code = numberChunkCode([['a', 'b'], ['c']]);
    expect(code.lineCount).toBe(3);
    expect(code.numbered).toBe('1 | a\n2 | b\n  ┆\n3 | c');
  });

  it('maps refs to absolute lines by walking the ranges', () => {
    const chunk = {
      ranges: [
        { path: 'a.ts', start: 10, end: 11 },
        { path: 'a.ts', start: 40, end: 42 },
      ],
    };
    expect(toAbsoluteLine(chunk, 1)).toEqual({ path: 'a.ts', line: 10 });
    expect(toAbsoluteLine(chunk, 3)).toEqual({ path: 'a.ts', line: 40 });
    expect(toAbsoluteLine(chunk, 5)).toEqual({ path: 'a.ts', line: 42 });
    expect(toAbsoluteLine(chunk, 6)).toBeNull();
    expect(toAbsoluteLine(chunk, 0)).toBeNull();
  });
});

describe('prompt', () => {
  const input = {
    chunkId: 'src/math.ts#clamp',
    chunkHash: 'abc',
    path: 'src/math.ts',
    title: 'clamp',
    sourceLang: 'typescript',
    rangeLines: [['export function clamp(n: number, lo: number, hi: number): number {', '  if (n < lo) return lo;', '}']],
    imports: [{ from: './util.js', name: 'assert', signature: 'export function assert(c: unknown): asserts c' }],
    existingStems: ['Old stem?'],
    count: 4,
    lang: 'tr',
  };

  it('numbers code from 1, mixes types and carries lang, imports and existing stems', () => {
    const p = buildGenerationPrompt(input);
    expect(p.task.lineCount).toBe(3);
    expect(p.user).toContain('1 | export function clamp');
    expect(p.user).toContain('- assert from ./util.js: export function assert');
    expect(p.user).toContain('- Old stem?');
    expect(p.user).toContain('types in order: behavior, edge_case, purpose, impact; language: tr.');
    expect(p.system).toMatch(/No trivia/);
    expect(p.system).toMatch(/similar length/);
    expect(p.system).toMatch(/L<n> or L<n>-L<m>/);
    expect(renderHostInstructions(p.task)).toContain(p.system);
    expect(renderHostInstructions(p.task)).toContain('"chunkHash": "abc"');
  });

  it('rejects an invalid lang and a typePlan of the wrong length', () => {
    expect(() => buildGenerationPrompt({ ...input, lang: 'Turkish' })).toThrow();
    expect(() => buildGenerationPrompt({ ...input, typePlan: ['behavior'] })).toThrow(/typePlan/);
  });

  it('type plan starts with the least represented type', () => {
    expect(planQuestionTypes(3, ['behavior', 'edge_case', 'purpose'], ['behavior', 'purpose'])).toEqual(['edge_case', 'purpose', 'behavior']);
  });
});

describe('blindVerify', () => {
  const task = { chunkId: 'c', sourceLang: 'typescript', lineCount: 1, code: '1 | x', context: { imports: [], enclosing: null } };
  const question = { stem: raw.stem, options: raw.options, correctIndex: raw.correctIndex };
  const answering = (pick: (opts: string[]) => number) => {
    const requests: VerifyRequest[] = [];
    const answer = async (req: VerifyRequest) => {
      requests.push(req);
      const opts = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]!);
      return { answerIndex: pick(opts), confidence: 'high' };
    };
    return { requests, answer };
  };

  it('keeps a question the verifier answers correctly, without leaking the key', async () => {
    const { requests, answer } = answering((opts) => opts.indexOf('10'));
    const out = await blindVerify({ answer, verifier: 'mock:m', task, question, seed: 'q_1' });
    expect(out).toEqual({ flagged: false, verifiedBy: 'mock:m' });
    expect(requests[0]!.user).not.toMatch(/correctIndex|explanation|L3/);
  });

  it('flags a mismatch and records nothing on failure', async () => {
    const wrong = answering((opts) => opts.indexOf('15'));
    expect(await blindVerify({ answer: wrong.answer, verifier: 'mock:m', task, question, seed: 'q_1' })).toEqual({
      flagged: true,
      verifiedBy: 'mock:m',
    });
    const failing = async () => {
      throw new Error('boom');
    };
    expect(await blindVerify({ answer: failing, verifier: 'mock:m', task, question, seed: 'q_1' })).toMatchObject({
      flagged: false,
      verifiedBy: null,
    });
  });

  it('permutation is deterministic and a permutation', () => {
    expect(optionPermutation('q_1')).toEqual(optionPermutation('q_1'));
    expect([...optionPermutation('q_2')].sort()).toEqual([0, 1, 2, 3]);
  });
});
