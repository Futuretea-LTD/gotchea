import { describe, expect, it } from 'vitest';
import { VERIFY_ANSWER_JSON_SCHEMA } from '../../src/generate/schema.js';
import { blindVerify, optionPermutation, type BlindVerifyInput, type VerifyRequest } from '../../src/generate/verify.js';

const OPTIONS = ['OPT-0 returns hi', 'OPT-1 returns lo', 'OPT-2 returns n', 'OPT-3 returns NaN'] as const;
const task = { chunkId: 'src/math.ts#clamp', sourceLang: 'typescript', lineCount: 1, code: '1 | return n;', context: { imports: [], enclosing: null } };
const SEEDS = Array.from({ length: 24 }, (_, i) => `q_${i.toString(16).padStart(12, '0')}`);

/** A verifier that answers with the display index of `original` (an index into OPTIONS), recording requests. */
function answering(original: number | ((displayed: string[]) => unknown)) {
  const requests: VerifyRequest[] = [];
  const answer = async (req: VerifyRequest) => {
    requests.push(req);
    const displayed = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]!);
    if (typeof original === 'function') return original(displayed);
    return { answerIndex: displayed.indexOf(OPTIONS[original]!), confidence: 'high' };
  };
  return { requests, answer };
}

const verify = (correctIndex: number, answer: BlindVerifyInput['answer'], seed = SEEDS[0]!) =>
  blindVerify({ answer, verifier: 'mock:verifier-1', task, question: { stem: 'What does clamp return for n > hi?', options: OPTIONS, correctIndex }, seed });

describe('blindVerify: flagged', () => {
  it('is not flagged when the verifier picks the correct option, for every key and permutation', async () => {
    for (const seed of SEEDS) {
      for (let correct = 0; correct < 4; correct++) {
        expect(await verify(correct, answering(correct).answer, seed), `${seed} key ${correct}`).toEqual({ flagged: false, verifiedBy: 'mock:verifier-1' });
      }
    }
  });

  it('is flagged when the verifier picks any other option, for every key and permutation', async () => {
    for (const seed of SEEDS) {
      for (let correct = 0; correct < 4; correct++) {
        for (let picked = 0; picked < 4; picked++) {
          if (picked === correct) continue;
          expect(await verify(correct, answering(picked).answer, seed), `${seed} key ${correct} picked ${picked}`).toEqual({
            flagged: true,
            verifiedBy: 'mock:verifier-1',
          });
        }
      }
    }
  });

  it('a low-confidence answer still decides the outcome', async () => {
    const low = (pick: number) => answering((d) => ({ answerIndex: d.indexOf(OPTIONS[pick]!), confidence: 'low' })).answer;
    expect(await verify(2, low(2))).toEqual({ flagged: false, verifiedBy: 'mock:verifier-1' });
    expect(await verify(2, low(1))).toEqual({ flagged: true, verifiedBy: 'mock:verifier-1' });
  });

  it('un-permutes the answer: answering the displayed index of the key as-is is not enough', async () => {
    // Find a seed whose permutation moves the key; answering the stored index would then be wrong.
    const seed = SEEDS.find((s) => optionPermutation(s)[0] !== 0)!;
    const raw = answering(() => ({ answerIndex: 0, confidence: 'high' }));
    expect(await verify(0, raw.answer, seed)).toMatchObject({ flagged: true });
  });
});

describe('blindVerify: failures leave the question unflagged and unverified', () => {
  it.each([
    ['answerIndex 4', { answerIndex: 4, confidence: 'high' }],
    ['answerIndex -1', { answerIndex: -1, confidence: 'high' }],
    ['answerIndex as a string', { answerIndex: '1', confidence: 'high' }],
    ['missing confidence', { answerIndex: 1 }],
    ['unknown confidence', { answerIndex: 1, confidence: 'certain' }],
    ['null', null],
  ])('%s', async (_name, reply) => {
    const out = await verify(1, async () => reply);
    expect(out).toMatchObject({ flagged: false, verifiedBy: null });
    expect(out.error).toBe('verifier returned an invalid answer');
  });

  it('a throwing verifier yields its message and no key', async () => {
    const out = await verify(1, async () => {
      throw new Error('HTTP 529 overloaded');
    });
    expect(out).toEqual({ flagged: false, verifiedBy: null, error: 'HTTP 529 overloaded' });
  });
});

describe('blindVerify: request', () => {
  it('sends a fresh low-effort request with the verify schema, code, stem and permuted options only', async () => {
    const { requests, answer } = answering(0);
    await verify(0, answer, SEEDS[3]);
    expect(requests).toHaveLength(1);
    const [req] = requests as [VerifyRequest];
    expect(req).toMatchObject({ schemaName: 'verify_answer', effort: 'low', schema: VERIFY_ANSWER_JSON_SCHEMA });
    expect(req.user).toContain('1 | return n;');
    expect(req.user).toContain('Question: What does clamp return for n > hi?');
    const displayed = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]);
    expect(displayed).toEqual(optionPermutation(SEEDS[3]!).map((i) => OPTIONS[i]));
    expect(`${req.system}\n${req.user}`).not.toMatch(/correctIndex|explanation|refs|behavior/);
  });

  it('permutes options deterministically per seed, and not always to the identity', () => {
    const perms = SEEDS.map((s) => optionPermutation(s));
    for (const p of perms) expect([...p].sort()).toEqual([0, 1, 2, 3]);
    expect(perms.map((p) => p.join())).toEqual(SEEDS.map((s) => optionPermutation(s).join()));
    expect(perms.some((p) => p.join() !== '0,1,2,3')).toBe(true);
    // Every original option lands at display index 0 for some seed: the key's position is not fixed.
    expect(new Set(perms.map((p) => p[0]))).toEqual(new Set([0, 1, 2, 3]));
  });
});
