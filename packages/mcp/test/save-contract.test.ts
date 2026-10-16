// save_questions contract (M2_DESIGN.md §8.2, §2.3 D1, §9, §10): input schema as the client
// sees it, exact output shape, persistence of accepted items only, the hash-mismatch gate,
// chunk-relative refs surviving a move, and get_map before/after a save.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, repoPaths, toAbsoluteLine, type Chunk } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { GetMapOutputSchema, SaveQuestionsOutputSchema, type MapNodeOut } from '../src/schemas.js';
import { FLAGGED_STEM, NOW, connect, createFixture, text, type Fixture } from './helpers.js';

const ALPHA = 'src/big.ts#alpha';
const BETA = 'src/big.ts#beta';
const GAMMA = 'src/big.ts#gamma';

let fx: Fixture;
let conn: Awaited<ReturnType<typeof connect>>;

beforeEach(async () => {
  fx = await createFixture();
  conn = await connect(fx.root, fx.env);
});
afterEach(async () => {
  await conn.close();
  await fx.cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}) => (await conn.client.callTool({ name, arguments: args })) as CallToolResult;
const chunkOf = async (id: string): Promise<Chunk> => (await new FsChunkStore(fx.root).load())!.chunks.find((c) => c.id === id)!;
const pool = (id: string) => new FsQuestionStore(fx.root).list(id);
const poolPath = (id: string) => new FsQuestionStore(fx.root).pathFor(id);
const questionsDir = async () => {
  const dir = repoPaths(fx.root).questionsDir;
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  return Promise.all(names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')] as const));
};

/** alpha/beta/gamma(x) run `x += i * x` for i = 0..107: an input of 0 stays 0. */
const base = (stem: string) => ({
  type: 'behavior',
  stem,
  options: ['It returns 0', 'It returns 1', 'It returns 107', 'It returns NaN'],
  correctIndex: 0,
  explanation: 'L2-L109 only ever multiply x by (1 + i), so 0 stays 0 and L110 returns it.',
  refs: [{ start: 2, end: 110 }],
  difficulty: 1,
});
const VALID_A = base('What does alpha return when it is called with 0?');
const VALID_B = { ...base('Which value comes out of the function for a zero argument once the loop is done?'), type: 'edge_case', difficulty: 2 };

/** One item per reason code reachable from a single batch, each failing only its own rule. */
const BATCH: [Record<string, unknown>, string | null][] = [
  [VALID_A, null],
  [{ ...base('What happens to x on the first loop line?'), options: ['a', 'b', 'c'] }, 'schema_invalid'],
  [{ ...base('What is x after the very first loop iteration?'), options: ['It returns 0', 'it returns 0.', 'It returns 107', 'It returns NaN'] }, 'options_not_distinct'],
  [{ ...base('What is x after the second loop iteration finishes?'), options: ['It returns 0', 'It returns 1', 'It returns 107', 'None of the above'] }, 'meta_option'],
  [base('Pick the correct answer: what does alpha give for 0?'), 'answer_leak_marker'],
  [{ ...base('Why does alpha return 0 for an input of 0?'), options: ['It returns 0 for an input of 0', 'b-wrong', 'c-wrong', 'd-wrong'] }, 'answer_leak_stem'],
  [
    { ...base('What comes back from alpha for a negative argument?'), options: ['It returns 0 because every iteration multiplies by zero', 'It returns 1', 'It returns 107', 'It returns NaN'] },
    'length_skew',
  ],
  [{ ...base('Where does the accumulator get updated during the loop?'), refs: [{ start: 0, end: 3 }] }, 'refs_out_of_range'],
  [{ ...base('What does the loop do to a value that starts at zero?'), explanation: 'Each step multiplies x by one plus the counter, so zero stays zero.' }, 'explanation_citation'],
  [base('How many lines does the body of alpha span in total?'), 'trivia'],
  [VALID_B, null],
  [{ ...VALID_A }, 'duplicate_batch'],
];
/** Distinctive submitted strings (stems, options, explanations); 1-char options would match anything. */
const SUBMITTED_TEXT = BATCH.flatMap(([q]) => [q['stem'] as string, ...((q['options'] as string[] | undefined) ?? []), q['explanation'] as string]).filter(
  (s) => s.length >= 8,
);

function find(node: MapNodeOut, id: string): MapNodeOut | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const OUTPUT_KEYS = ['accepted', 'chunkId', 'initialized', 'reason', 'rejected', 'savedCount', 'scanned', 'status', 'target', 'usableQuestions'];

describe('save_questions: schema as listed to clients', () => {
  it('input is strict, needs chunkId/chunkHash/questions and caps the batch at 20', async () => {
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === 'save_questions')!;
    const input = tool.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties?: unknown };
    expect(Object.keys(input.properties).sort()).toEqual(['chunkHash', 'chunkId', 'lang', 'questions']);
    expect([...input.required].sort()).toEqual(['chunkHash', 'chunkId', 'questions']);
    expect(input.additionalProperties).toBe(false);
    expect(input.properties['questions']).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
    expect(input.properties['chunkId']).toMatchObject({ type: 'string', minLength: 1 });
    expect(input.properties['chunkHash']).toMatchObject({ type: 'string', minLength: 1 });
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, openWorldHint: false });

    const output = tool.outputSchema as { properties: Record<string, unknown>; additionalProperties?: unknown };
    expect(Object.keys(output.properties).sort()).toEqual(OUTPUT_KEYS);
    expect(output.additionalProperties).toBe(false);
  });

  it.each([
    ['missing chunkHash', { chunkId: ALPHA, questions: [VALID_A] }],
    ['missing chunkId', { chunkHash: 'h', questions: [VALID_A] }],
    ['missing questions', { chunkId: ALPHA, chunkHash: 'h' }],
    ['an extra key', { chunkId: ALPHA, chunkHash: 'h', questions: [VALID_A], force: true }],
    ['an empty chunkHash', { chunkId: ALPHA, chunkHash: '', questions: [VALID_A] }],
    ['an empty batch', { chunkId: ALPHA, chunkHash: 'h', questions: [] }],
    ['21 items', { chunkId: ALPHA, chunkHash: 'h', questions: Array.from({ length: 21 }, () => VALID_A) }],
    ['a non-object item', { chunkId: ALPHA, chunkHash: 'h', questions: ['just a string'] }],
  ])('rejects %s at the SDK level and persists nothing', async (_label, args) => {
    // Use the real hash so only the shape is wrong.
    const hash = (await chunkOf(ALPHA)).contentHash;
    const withHash = 'chunkHash' in args && args.chunkHash === 'h' ? { ...args, chunkHash: hash } : args;
    const before = await questionsDir();
    let res: CallToolResult | null = null;
    try {
      res = await call('save_questions', withHash);
    } catch {
      // A thrown protocol error is an acceptable SDK-level rejection too.
    }
    if (res) {
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toBeUndefined();
      expect(text(res)).toMatch(/invalid|validation/i);
    }
    expect(await questionsDir()).toEqual(before);
  });
});

describe('save_questions: response shape and persistence', () => {
  it('returns exactly the output keys, per-index reasons, and persists only the accepted items with stamps', async () => {
    const alpha = await chunkOf(ALPHA);
    expect(await pool(ALPHA)).toEqual([]);
    const res = await call('save_questions', { chunkId: ALPHA, chunkHash: alpha.contentHash, questions: BATCH.map(([q]) => q) });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(OUTPUT_KEYS);
    const out = SaveQuestionsOutputSchema.parse(sc);

    expect(out).toMatchObject({ initialized: true, scanned: true, status: 'saved', reason: null, chunkId: ALPHA });
    const expectedAccepted = BATCH.flatMap(([, r], i) => (r === null ? [i] : []));
    const expectedRejected = BATCH.flatMap(([, r], i) => (r === null ? [] : [[i, r]]));
    expect(out.accepted.map((a) => a.index)).toEqual(expectedAccepted);
    expect(out.rejected.map((r) => [r.index, r.reason])).toEqual(expectedRejected);
    // The brief's "savedCount" is accepted.length in the spec; both agree.
    expect(out.savedCount).toBe(out.accepted.length);
    for (const a of out.accepted) expect(Object.keys(a).sort()).toEqual(['id', 'index']);
    for (const r of out.rejected) {
      expect(Object.keys(r).sort()).toEqual(['detail', 'index', 'reason']);
      expect(r.detail.length).toBeGreaterThan(0);
    }
    expect(out.usableQuestions).toBe(2);
    expect(out.target).toBeGreaterThanOrEqual(2);

    // Nothing of the submission comes back, in text or structured content.
    const seen = text(res) + JSON.stringify(res.structuredContent);
    for (const s of SUBMITTED_TEXT) expect(seen, s).not.toContain(s);

    // Disk: exactly the accepted items, stamped, in a single new file.
    const stored = await pool(ALPHA);
    expect(stored).toHaveLength(out.savedCount);
    expect(stored.map((q) => q.id).sort()).toEqual(out.accepted.map((a) => a.id).sort());
    expect(stored.map((q) => q.stem).sort()).toEqual([VALID_A.stem, VALID_B.stem].sort());
    for (const q of stored) {
      expect(q).toMatchObject({
        chunkId: ALPHA,
        chunkHash: alpha.contentHash,
        chunkLines: 111,
        generatedBy: 'host:test',
        lang: 'en',
        status: 'ok',
        flagged: false,
        verifiedBy: null,
        createdAt: NOW.toISOString(),
      });
      expect(q.id).toMatch(/^q_[0-9a-f]{12}$/);
      expect(q.refs).toEqual([{ start: 2, end: 110 }]);
    }
    expect(stored.find((q) => q.stem === VALID_B.stem)).toMatchObject({ type: 'edge_case', difficulty: 2, correctIndex: 0 });
  });

  it('the rejected-gate and not-initialised responses carry the same key set', async () => {
    const gate = await call('save_questions', { chunkId: ALPHA, chunkHash: 'stale', questions: [VALID_A] });
    expect(Object.keys(gate.structuredContent!).sort()).toEqual(OUTPUT_KEYS);
    expect(SaveQuestionsOutputSchema.parse(gate.structuredContent)).toMatchObject({ savedCount: 0, accepted: [], rejected: [], usableQuestions: null, target: null });
  });

  it('a flagged stored question still blocks a near-duplicate stem', async () => {
    // The seeded math leaf holds an ok and a flagged question at the current hash.
    const math = await chunkOf(fx.seededChunkId);
    const item = {
      type: 'behavior',
      stem: FLAGGED_STEM,
      options: ['lower bound check', 'upper bound check', 'fallthrough return', 'no guard at all'],
      correctIndex: 0,
      explanation: 'L2 checks n < lo before L3 checks n > hi.',
      refs: [{ start: 2, end: 3 }],
      difficulty: 1,
    };
    const res = await call('save_questions', { chunkId: math.id, chunkHash: math.contentHash, questions: [item] });
    const out = SaveQuestionsOutputSchema.parse(res.structuredContent);
    expect(out.rejected).toEqual([{ index: 0, reason: 'duplicate_stored', detail: 'near-duplicate of stored question q2 (J=1.00)' }]);
    // The detail names the id only, never the flagged stem.
    expect(text(res)).not.toContain('SEED-FLAGGED-STEM');
  });
});

describe('save_questions: hash mismatch', () => {
  it('refuses a stale hash, creates no pool file and does not leak the current hash', async () => {
    const alpha = await chunkOf(ALPHA);
    const before = await questionsDir();
    const res = await call('save_questions', { chunkId: ALPHA, chunkHash: `${alpha.contentHash.slice(0, -1)}0`, questions: [VALID_A, VALID_B] });
    expect(res.isError).toBe(true);
    const out = SaveQuestionsOutputSchema.parse(res.structuredContent);
    expect(out).toMatchObject({ status: 'rejected', reason: 'chunk_hash_mismatch', chunkId: ALPHA, savedCount: 0, accepted: [], rejected: [] });
    expect(text(res)).toContain('get_generation_tasks');
    expect(JSON.stringify(res)).not.toContain(alpha.contentHash);
    expect(await questionsDir()).toEqual(before);
    await expect(readFile(poolPath(ALPHA))).rejects.toThrow();
    expect(await pool(ALPHA)).toEqual([]);
  });

  it('a stale hash after a real edit + rescan persists nothing to the existing pool', async () => {
    const alpha = await chunkOf(ALPHA);
    expect(SaveQuestionsOutputSchema.parse((await call('save_questions', { chunkId: ALPHA, chunkHash: alpha.contentHash, questions: [VALID_A] })).structuredContent).savedCount).toBe(1);
    const path = join(fx.root, 'src/big.ts');
    await writeFile(path, (await readFile(path, 'utf8')).replace('x += 0 * x;', 'x += 1000 * x;'));
    await call('scan');
    const fresh = await chunkOf(ALPHA);
    expect(fresh.contentHash).not.toBe(alpha.contentHash);

    const before = await questionsDir();
    const res = await call('save_questions', { chunkId: ALPHA, chunkHash: alpha.contentHash, questions: [VALID_B] });
    expect(SaveQuestionsOutputSchema.parse(res.structuredContent).reason).toBe('chunk_hash_mismatch');
    expect(JSON.stringify(res)).not.toContain(fresh.contentHash);
    expect(await questionsDir()).toEqual(before);
    // The old question went stale on rescan and no longer counts.
    const map = GetMapOutputSchema.parse((await call('get_map', { path: 'src/big.ts' })).structuredContent);
    expect(find(map.root!, ALPHA)).toMatchObject({ okQuestions: 0, state: { color: 'grey' } });
  });
});

describe('chunk-relative refs (D1) through MCP scan', () => {
  it('a chunk moved by an insertion above keeps its question, hash and refs; display lines follow', async () => {
    const before = await chunkOf(BETA);
    const res = await call('save_questions', { chunkId: BETA, chunkHash: before.contentHash, questions: [base('What does beta return when it is called with 0?')] });
    expect(SaveQuestionsOutputSchema.parse(res.structuredContent).savedCount).toBe(1);
    const [q] = await pool(BETA);
    const path = join(fx.root, 'src/big.ts');
    const oldLines = (await readFile(path, 'utf8')).split('\n');
    const oldAbs = toAbsoluteLine(before, q!.refs[0]!.start)!;

    // Insert a new 6-line function between alpha and beta.
    const inserted = ['export function inserted(y: number): number {', '  const a = y + 1;', '  const b = a * 2;', '  const c = b - 3;', '  return c;', '}'];
    const betaAt = oldLines.indexOf('export function beta(x: number): number {');
    await writeFile(path, [...oldLines.slice(0, betaAt), ...inserted, '', ...oldLines.slice(betaAt)].join('\n'));
    const scan = await call('scan');
    expect(scan.isError).toBeFalsy();

    const after = await chunkOf(BETA);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.ranges[0]!.start).toBe(before.ranges[0]!.start + inserted.length + 1);
    const [q2] = await pool(BETA);
    expect(q2).toEqual(q); // status ok, chunkHash and refs untouched (never rebased)

    const newLines = (await readFile(path, 'utf8')).split('\n');
    const newAbs = toAbsoluteLine(after, q2!.refs[0]!.start)!;
    expect(newAbs).toEqual({ path: 'src/big.ts', line: oldAbs.line + inserted.length + 1 });
    expect(newLines[newAbs.line - 1]).toBe(oldLines[oldAbs.line - 1]);

    const map = GetMapOutputSchema.parse((await call('get_map', { path: 'src/big.ts' })).structuredContent);
    const node = find(map.root!, BETA)!;
    expect(node).toMatchObject({ okQuestions: 1, lines: { start: after.ranges[0]!.start, end: after.ranges[0]!.end } });
    expect(node.state.color).not.toBe('grey');
  });
});

describe('get_map before and after save_questions', () => {
  it('a grey 0-question leaf turns non-grey with the saved count; parents show Σ', async () => {
    const mapText = async () => text(await call('get_map'));
    const leafOf = async (id: string) => find(GetMapOutputSchema.parse((await call('get_map')).structuredContent).root!, id)!;

    const beta0 = await leafOf(BETA);
    expect(beta0).toMatchObject({ okQuestions: 0, state: { color: 'grey', R: null } });
    const text0 = await mapText();
    expect(text0).toMatch(/⬜ beta · \d+ LOC · 0 questions/);
    expect(text0).not.toMatch(/big\.ts · \d+ LOC · Σ/);
    expect(text0).toMatch(/src\/ · \d+ LOC · Σ 1 question/); // the seeded math question
    const status0 = (await call('get_status')).structuredContent as { questions: number };

    const beta = await chunkOf(BETA);
    const res = await call('save_questions', {
      chunkId: BETA,
      chunkHash: beta.contentHash,
      questions: [base('What does beta return when it is called with 0?'), { ...base('Which value comes out of beta for a zero argument once the loop is done?'), type: 'edge_case' }],
    });
    const out = SaveQuestionsOutputSchema.parse(res.structuredContent);
    expect(out.savedCount).toBe(2);

    const beta1 = await leafOf(BETA);
    expect(beta1.okQuestions).toBe(out.accepted.length);
    expect(beta1.questionCount).toBe(beta0.questionCount); // quiz size from the band, not the pool
    expect(beta1.state).toEqual({ color: 'red', R: 0, dueAt: null });
    const text1 = await mapText();
    expect(text1).toMatch(/🟥 beta · \d+ LOC · 2 questions/);
    expect(text1).toMatch(/big\.ts · \d+ LOC · Σ 2 questions/);
    expect(text1).toMatch(/src\/ · \d+ LOC · Σ 3 questions/);
    expect(text1.split('\n')[0]).toMatch(/ · 3 questions · next step: take a quiz$/);
    // A depth cut hides the leaves, not their totals.
    const cut = text(await call('get_map', { depth: 1 }));
    expect(cut).not.toMatch(/big\.ts/);
    expect(cut).toMatch(/src\/ · \d+ LOC · Σ 3 questions/);
    expect((await call('get_status')).structuredContent).toMatchObject({ questions: status0.questions + 2 });
  });

  it('flagged-only and stale-hash pools do not count', async () => {
    const store = new FsQuestionStore(fx.root);
    const [gamma, alpha] = [await chunkOf(GAMMA), await chunkOf(ALPHA)];
    const q = (chunk: Chunk, over: Partial<QuestionPrivate>): QuestionPrivate => ({
      id: 'q_000000000001',
      chunkId: chunk.id,
      chunkHash: chunk.contentHash,
      type: 'behavior',
      stem: 'What does this function return for 0?',
      options: ['a0', 'b0', 'c0', 'd0'],
      correctIndex: 0,
      explanation: 'L2 keeps zero at zero.',
      refs: [{ start: 2, end: 2 }],
      difficulty: 1,
      lang: 'en',
      generatedBy: 'host:test',
      promptVersion: 'p1',
      status: 'ok',
      flagged: false,
      chunkLines: 111,
      verifiedBy: null,
      createdAt: NOW.toISOString(),
      ...over,
    });
    await store.save(GAMMA, [q(gamma, { flagged: true, verifiedBy: 'anthropic:mock' })]);
    await store.save(ALPHA, [q(alpha, { chunkHash: 'an-older-hash' })]);

    const res = await call('get_map', { path: 'src/big.ts' });
    const map = GetMapOutputSchema.parse(res.structuredContent);
    for (const id of [GAMMA, ALPHA]) expect(find(map.root!, id), id).toMatchObject({ okQuestions: 0, state: { color: 'grey' } });
    expect(text(res)).not.toMatch(/Σ/);
    expect(text(res)).toMatch(/gamma · \d+ LOC · 0 questions/);
  });
});
