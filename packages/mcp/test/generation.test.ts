import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsChunkStore, questionFileName } from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import { GetGenerationTasksOutputSchema, GetMapOutputSchema, SaveQuestionsOutputSchema, type MapNodeOut } from '../src/schemas.js';
import { FLAGGED_STEM, SEED_STEM, connect, createFixture, text, type Fixture } from './helpers.js';

let fx: Fixture;
let conn: Awaited<ReturnType<typeof connect>>;
const call = (name: string, args: Record<string, unknown> = {}) => conn.client.callTool({ name, arguments: args });
const ALPHA = 'src/big.ts#alpha';

/** alpha(x) runs `x += i * x` for i = 0..107: an input of 0 stays 0. */
const valid = (stem = 'What does alpha return when it is called with 0?') => ({
  type: 'behavior',
  stem,
  options: ['It returns 0', 'It returns 1', 'It returns 107', 'It returns NaN'],
  correctIndex: 0,
  explanation: 'L2-L109 only ever multiply x by (1 + i), so 0 stays 0 and L110 returns it.',
  refs: [{ start: 2, end: 110 }],
  difficulty: 1,
});

async function hashOf(id: string): Promise<string> {
  const chunks = (await new FsChunkStore(fx.root).load())!.chunks;
  return chunks.find((c) => c.id === id)!.contentHash;
}

function find(node: MapNodeOut, id: string): MapNodeOut | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

beforeAll(async () => {
  fx = await createFixture();
  conn = await connect(fx.root, fx.env);
});

afterAll(async () => {
  await conn.close();
  await fx.cleanup();
});

describe('get_generation_tasks', () => {
  it('returns prioritised tasks with chunk-relative numbered code, context and instructions', async () => {
    const res = await call('get_generation_tasks', { limit: 10 });
    expect(res.isError).toBeFalsy();
    const out = GetGenerationTasksOutputSchema.parse(res.structuredContent);
    const ids = out.tasks.map((t) => t.chunkId);
    // Grey (no usable questions) first; the seeded leaf comes last.
    expect(ids.at(-1)).toBe(fx.seededChunkId);
    expect(ids.slice(0, 3).sort()).toEqual(['src/big.ts#alpha', 'src/big.ts#beta', 'src/big.ts#gamma']);
    expect(out.remaining).toBe(0);

    const alpha = out.tasks.find((t) => t.chunkId === ALPHA)!;
    expect(alpha.chunkHash).toBe(await hashOf(ALPHA));
    expect(alpha.code.split('\n')[0]).toMatch(/^\s*1 \| export function alpha\(x: number\): number \{$/);
    expect(alpha.lineCount).toBe(111);
    expect(alpha.typePlan).toHaveLength(alpha.count);
    expect(alpha.questionLang).toBe('en');
    expect(alpha.instructions).toContain('save_questions');
    expect(alpha.instructions).toContain(alpha.chunkHash);
    expect(alpha.instructions).toContain('"correctIndex"');

    const seeded = out.tasks.find((t) => t.chunkId === fx.seededChunkId)!;
    // Usable stems only: the flagged one is not exposed.
    expect(seeded.existingStems).toEqual([SEED_STEM]);
    expect(seeded.code.split('\n')[0]).toBe(' 1 | export function clamp(n: number, lo: number, hi: number): number {');
  });

  it('defaults to 3 tasks and reports the rest as remaining; text works without structuredContent', async () => {
    const res = await call('get_generation_tasks');
    const out = GetGenerationTasksOutputSchema.parse(res.structuredContent);
    expect(out.tasks).toHaveLength(3);
    expect(out.remaining).toBe(1);
    expect(text(res)).toMatch(/^3 tasks · 1 more chunk need questions/);
    expect(text(res)).toContain(`chunkHash ${out.tasks[0]!.chunkHash}`);
    expect(text(res)).toContain('Code:');
  });

  it('includes import signatures the chunk uses', async () => {
    const { resolveConfig } = await import('gotchea-core');
    const { getGenerationTasks } = await import('gotchea-core');
    // src/index.ts is under minLoc, so ask core directly with minLoc 0.
    const config = resolveConfig({ questions: { minLoc: 0 } });
    const res = await getGenerationTasks(fx.root, { config, limit: 20 });
    const index = res!.tasks.find((t) => t.chunkId === 'src/index.ts')!;
    expect(index.context.imports).toEqual([{ from: './math.js', name: 'clamp', signature: 'export function clamp(n: number, lo: number, hi: number): number {' }]);
  });

  it('rejects an invalid lang with an error', async () => {
    const res = await call('get_generation_tasks', { lang: 'English!' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('invalid lang');
  });
});

describe('save_questions', () => {
  it('saves valid items, reports invalid ones per index, and stamps host metadata', async () => {
    const leaking = { ...valid('Why does alpha return 0 for an input of 0?'), options: ['It returns 0 for an input of 0', 'b-wrong', 'c-wrong', 'd-wrong'] };
    const res = await call('save_questions', {
      chunkId: ALPHA,
      chunkHash: await hashOf(ALPHA),
      questions: [valid(), { ...valid('What happens to x on the first loop line?'), options: ['a', 'b', 'c'] }, leaking],
    });
    expect(res.isError).toBeFalsy();
    const out = SaveQuestionsOutputSchema.parse(res.structuredContent);
    expect(out).toMatchObject({ status: 'saved', reason: null, chunkId: ALPHA, savedCount: 1 });
    expect(out.accepted.map((a) => a.index)).toEqual([0]);
    expect(out.rejected.map((r) => [r.index, r.reason])).toEqual([
      [1, 'schema_invalid'],
      [2, 'answer_leak_stem'],
    ]);
    expect(out.usableQuestions).toBe(1);
    expect(out.target).toBeGreaterThan(1);

    const stored = await new FsQuestionStore(fx.root).list(ALPHA);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: out.accepted[0]!.id,
      chunkHash: await hashOf(ALPHA),
      chunkLines: 111,
      generatedBy: 'host:test',
      lang: 'en',
      status: 'ok',
      flagged: false,
      verifiedBy: null,
      createdAt: '2026-10-14T12:00:00.000Z',
    });
  });

  it('get_map then shows the leaf with its question count, no longer grey', async () => {
    const res = await call('get_map', { path: 'src/big.ts' });
    const out = GetMapOutputSchema.parse(res.structuredContent);
    const alpha = find(out.root!, ALPHA)!;
    expect(alpha.okQuestions).toBe(1);
    expect(alpha.state.color).not.toBe('grey');
    expect(find(out.root!, 'src/big.ts#beta')!.state.color).toBe('grey');
    expect(text(res)).toMatch(/alpha · \d+ LOC · 1 soru/);
    expect(text(res)).toMatch(/big\.ts · \d+ LOC · Σ 1 soru/);
  });

  it('get_generation_tasks moves the chunk behind the grey ones and lists its stem', async () => {
    const out = GetGenerationTasksOutputSchema.parse((await call('get_generation_tasks', { limit: 10 })).structuredContent);
    const ids = out.tasks.map((t) => t.chunkId);
    expect(ids.slice(0, 2).sort()).toEqual(['src/big.ts#beta', 'src/big.ts#gamma']);
    expect(out.tasks.find((t) => t.chunkId === ALPHA)!.existingStems).toEqual([valid().stem]);
  });

  it('an identical resubmission is rejected as a duplicate', async () => {
    const out = SaveQuestionsOutputSchema.parse(
      (await call('save_questions', { chunkId: ALPHA, chunkHash: await hashOf(ALPHA), questions: [valid()] })).structuredContent,
    );
    expect(out.savedCount).toBe(0);
    expect(out.rejected).toEqual([{ index: 0, reason: 'duplicate_stored', detail: expect.stringMatching(/^near-duplicate of stored question q_/) }]);
  });

  it('refuses the whole call on a hash mismatch and leaves the pool file untouched', async () => {
    const file = join(fx.root, '.gotchea', 'questions', questionFileName(fx.seededChunkId));
    const before = await readFile(file);
    const res = await call('save_questions', { chunkId: fx.seededChunkId, chunkHash: 'stale-hash', questions: [valid()] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('chunk_hash_mismatch');
    expect(text(res)).toContain('get_generation_tasks');
    expect(text(res)).not.toContain(await hashOf(fx.seededChunkId));
    const out = SaveQuestionsOutputSchema.parse(res.structuredContent);
    expect(out).toMatchObject({ status: 'rejected', reason: 'chunk_hash_mismatch', savedCount: 0, accepted: [], rejected: [] });
    expect(await readFile(file)).toEqual(before);
  });

  it('refuses an unknown chunk and a non-leaf chunk', async () => {
    const unknown = await call('save_questions', { chunkId: 'src/nope.ts#x', chunkHash: 'h', questions: [valid()] });
    expect(unknown.isError).toBe(true);
    expect(SaveQuestionsOutputSchema.parse(unknown.structuredContent).reason).toBe('unknown_chunk');

    const parent = await call('save_questions', { chunkId: 'src/big.ts', chunkHash: await hashOf('src/big.ts'), questions: [valid()] });
    expect(parent.isError).toBe(true);
    expect(SaveQuestionsOutputSchema.parse(parent.structuredContent).reason).toBe('not_leaf');
  });

  it('rejects at the SDK level when the call shape itself is wrong', async () => {
    const res = await call('save_questions', { chunkId: ALPHA, chunkHash: 'h', questions: [] });
    expect(res.isError).toBe(true);
  });
});

describe('save_questions after an edit', () => {
  it('refuses a chunk whose file changed since the scan', async () => {
    const path = join(fx.root, 'src/big.ts');
    const original = await readFile(path, 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, original.replace('x += 0 * x;', 'x += 1000 * x;'));
    try {
      const res = await call('save_questions', { chunkId: ALPHA, chunkHash: await hashOf(ALPHA), questions: [valid('Is alpha(0) still zero after the loop?')] });
      expect(res.isError).toBe(true);
      expect(SaveQuestionsOutputSchema.parse(res.structuredContent).reason).toBe('chunk_changed_since_scan');
      const tasks = GetGenerationTasksOutputSchema.parse((await call('get_generation_tasks', { limit: 10 })).structuredContent);
      expect(tasks.changedSinceScan).toContain(ALPHA);
      expect(tasks.tasks.map((t) => t.chunkId)).not.toContain(ALPHA);
    } finally {
      await writeFile(path, original);
    }
  });

  it('never exposes the flagged stem', async () => {
    const res = await call('get_generation_tasks', { limit: 10 });
    expect(JSON.stringify(res)).not.toContain(FLAGGED_STEM);
  });
});
