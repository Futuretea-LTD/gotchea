// Answer-key isolation over the whole pre-submit surface (PLAN.md §6, M3_DESIGN.md §10.3): no key,
// explanation or line reference, as a field or as a value, appears before the answer to that question
// was recorded; and the strict public schemas reject anything extra.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_KEYS, FsChunkStore, PublicQuestionViewSchema, SessionSchema, assertPublicView, computeRepoId, seededRng, userPaths } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { StartQuizOutputSchema, SubmitAnswerOutputSchema } from '../src/schemas.js';
import { NOW, connect, createFixture, text, type Fixture } from './helpers.js';

const LEAF = 'src/math.ts';
const KEYS = [...new Set([...FORBIDDEN_KEYS, 'correctIndex', 'correctDisplayIndex', 'correctOptionIndex', 'correctText', 'explanation', 'refs', 'startLine', 'endLine'])];
const expl = (i: number) => `EXPL-SENT-${i}: only the second guard returns hi.`;
// Line-reference renderings of the seeded refs (chunk lines 2–3 of src/math.ts).
const REF_TEXT = /Look at|src\/math\.ts[^\n]*L\d|L2[–-]L3/;

let fx: Fixture;
let c: Awaited<ReturnType<typeof connect>>;

beforeEach(async () => {
  fx = await createFixture();
  const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((x) => x.id === LEAF)!;
  const qs: QuestionPrivate[] = Array.from({ length: 4 }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: leaf.id,
    chunkHash: leaf.contentHash,
    chunkLines: 4,
    type: 'behavior',
    stem: `STEM-SENT-${i}: what happens in case ${i}?`,
    options: [`OPT-${i}-A`, `OPT-${i}-B`, `OPT-${i}-C`, `OPT-${i}-D`],
    correctIndex: (i % 4) as 0 | 1 | 2 | 3,
    explanation: expl(i),
    refs: [{ start: 2, end: 3 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(fx.root).save(leaf.id, qs);
  c = await connect(fx.root, fx.env, { rng: seededRng(21) });
});
afterEach(async () => {
  await c.close();
  await fx.cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}) => (await c.client.callTool({ name, arguments: args })) as CallToolResult;

/** Every object key at any depth, skipping the subtrees named in `skip`. */
function keysOf(v: unknown, skip: ReadonlySet<string> = new Set(), out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, skip, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (skip.has(k)) continue;
      out.push(k);
      keysOf(x, skip, out);
    }
  }
  return out;
}
const everything = (res: CallToolResult): string => `${text(res)}\n${JSON.stringify(res.structuredContent ?? null)}`;

function expectClean(res: CallToolResult, label: string, skip: ReadonlySet<string> = new Set()): void {
  const keys = keysOf(res.structuredContent, skip);
  for (const k of KEYS) expect(keys, `${label}: key ${k}`).not.toContain(k);
  if (skip.size === 0) {
    const all = everything(res);
    expect(all, label).not.toMatch(/EXPL-SENT/);
    expect(all, label).not.toMatch(REF_TEXT);
    expect(all, label).not.toMatch(/correctIndex|correctDisplayIndex|"explanation"/);
  }
}

describe('pre-submit outputs', () => {
  it('start_quiz (every variant) leaks no key, explanation or line reference', async () => {
    const variants: [string, Record<string, unknown>][] = [
      ['by chunkId', { chunkId: LEAF }],
      ['by chunkId + count', { chunkId: LEAF, count: 3 }],
      ['by path', { path: 'src' }],
      ['by file path', { path: 'src/math.ts' }],
      ['no target', {}],
      ['both targets (refused)', { path: 'src', chunkId: LEAF }],
      ['unknown chunk (refused)', { chunkId: 'nope.ts#x' }],
      ['bad lang (refused)', { chunkId: LEAF, lang: 'x!' }],
      ['chunk without questions (refused)', { path: 'src/util' }],
    ];
    for (const [label, args] of variants) {
      const res = await call('start_quiz', args);
      expectClean(res, `start_quiz ${label}`);
      if (res.isError) {
        // Refusals carry the strict schema's shape too (the SDK skips output validation on errors).
        expect(StartQuizOutputSchema.safeParse(res.structuredContent).success, label).toBe(true);
      } else {
        const out = StartQuizOutputSchema.parse(res.structuredContent);
        expect(Object.keys(out.question!).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total']);
        for (const o of out.question!.options) expect(Object.keys(o).sort()).toEqual(['index', 'label', 'text']);
        expect(() => assertPublicView(out.question)).not.toThrow();
      }
    }
  });

  it('a resumed start_quiz is as clean as a fresh one', async () => {
    const first = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    const q = first.question!;
    const idx = q.options.findIndex((o) => o.text.endsWith('-A'));
    await call('submit_answer', { sessionId: first.session!.id, questionId: q.questionId, displayIndex: idx });
    const again = await call('start_quiz', { chunkId: LEAF });
    expect(StartQuizOutputSchema.parse(again.structuredContent).status).toBe('resumed');
    // The text of a resumed quiz must not repeat the previous reveal either.
    expectClean(again, 'resumed');
  });

  it('the text and structured content of start_quiz show the same four options, nothing else from the pool', async () => {
    const res = await call('start_quiz', { chunkId: LEAF });
    const q = StartQuizOutputSchema.parse(res.structuredContent).question!;
    const all = everything(res);
    const shown = new Set(q.options.map((o) => o.text));
    // Options of OTHER questions never appear (only this question's four texts do).
    for (const m of all.matchAll(/OPT-\d-[A-D]/g)) expect(shown.has(m[0]), m[0]).toBe(true);
    // Neither do stems of other questions.
    for (const m of all.matchAll(/STEM-SENT-\d/g)) expect(q.stem.startsWith(m[0])).toBe(true);
  });

  it('the read tools never expose explanations, options or keys either', async () => {
    await call('start_quiz', { chunkId: LEAF });
    for (const [name, args] of [
      ['get_map', {}],
      ['get_status', {}],
      ['get_generation_tasks', {}],
      ['get_chunk_for_file', { path: 'src/math.ts' }],
    ] as [string, Record<string, unknown>][]) {
      const res = await call(name, args);
      const keys = keysOf(res.structuredContent);
      for (const k of ['correctIndex', 'correctDisplayIndex', 'correctText', 'explanation']) expect(keys, `${name}: ${k}`).not.toContain(k);
      expect(everything(res), name).not.toMatch(/EXPL-SENT|OPT-\d-[A-D]/);
    }
  });

  it('the persisted session file holds no key, stem, option or explanation', async () => {
    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    const dir = userPaths(await computeRepoId(fx.root), fx.env).sessionsDir;
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    expect(names).toEqual([`${out.session!.id}.json`]);
    const raw = await readFile(join(dir, names[0]!), 'utf8');
    expect(SessionSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    expect(raw).not.toMatch(/STEM-SENT|OPT-|EXPL-SENT|correctIndex|explanation|"refs"|stem|options/);
  });

  it('tool listings (descriptions and schemas) carry no sentinel; only submit_answer.reveal may name an answer field', async () => {
    const { tools } = await c.client.listTools();
    for (const t of tools) {
      expect(JSON.stringify(t), t.name).not.toMatch(/EXPL-SENT|STEM-SENT|OPT-\d/);
      const skip = t.name === 'submit_answer' ? new Set(['reveal']) : new Set<string>();
      const keys = keysOf(t.outputSchema, skip);
      for (const k of KEYS) expect(keys, `${t.name} output schema: ${k}`).not.toContain(k);
      const inKeys = keysOf(t.inputSchema);
      for (const k of KEYS) expect(inKeys, `${t.name} input schema: ${k}`).not.toContain(k);
    }
  });
});

describe('the detector itself', () => {
  it('flags a real reveal (so a clean result above is meaningful)', async () => {
    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    const q = out.question!;
    const res = await call('submit_answer', { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 0 });
    expect(() => expectClean(res, 'reveal')).toThrow();
    // ...but the reveal subtree exemption is path-based and does not hide leaks elsewhere.
    expect(() => expectClean(res, 'reveal', new Set(['reveal']))).not.toThrow();
    const planted = { ...res, structuredContent: { ...res.structuredContent, next: { explanation: 'x' } } };
    expect(() => expectClean(planted, 'planted', new Set(['reveal']))).toThrow();
  });
});

describe('reveal timing', () => {
  it("question k's explanation appears in no result returned before the answer to k was submitted", async () => {
    const transcript: { label: string; res: CallToolResult }[] = [];
    const start = await call('start_quiz', { chunkId: LEAF });
    transcript.push({ label: 'start', res: start });
    const out = StartQuizOutputSchema.parse(start.structuredContent);
    const sessionId = out.session!.id;
    let q = out.question!;
    const order: string[] = [];
    for (;;) {
      order.push(q.questionId);
      const n = Number(q.questionId.slice(-12)) - 1; // seeded as q_…<i+1>
      const res = await call('submit_answer', { sessionId, questionId: q.questionId, displayIndex: 0 });
      // This result may reveal exactly the question just answered, and no other.
      const body = everything(res);
      expect(body).toContain(expl(n));
      for (let other = 0; other < 4; other++) if (other !== n) expect(body, `answer to q${n} revealed q${other}`).not.toContain(expl(other));
      // And the `next` block of this very result is a clean public view.
      const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
      expect(keysOf(parsed.next)).not.toEqual(expect.arrayContaining(['explanation']));
      if (parsed.next) expect(() => assertPublicView(parsed.next)).not.toThrow();
      transcript.push({ label: `answer ${order.length}`, res });
      if (parsed.status === 'completed') break;
      q = parsed.next!;
    }
    // Everything before the k-th answer is free of question k's explanation.
    for (let k = 0; k < order.length; k++) {
      const n = Number(order[k]!.slice(-12)) - 1;
      for (const t of transcript.slice(0, k + 1)) expect(everything(t.res), `${t.label} vs q${n}`).not.toContain(expl(n));
    }
  });

  it('refused submits (unknown session/question, bad index, out of order, replay) reveal nothing', async () => {
    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    const sessionId = out.session!.id;
    const q1 = out.question!;
    const refusals = [
      await call('submit_answer', { sessionId: 'qs_0123456789abcdef', questionId: q1.questionId, displayIndex: 0 }),
      await call('submit_answer', { sessionId: '../../etc/passwd', questionId: q1.questionId, displayIndex: 0 }),
      await call('submit_answer', { sessionId, questionId: 'q_ffffffffffff', displayIndex: 0 }),
      await call('submit_answer', { sessionId, questionId: 'q_000000000004', displayIndex: 0 }), // a real id, but not the current one
    ];
    for (const [i, r] of refusals.entries()) {
      expect(r.isError, `refusal ${i}`).toBe(true);
      expectClean(r, `refusal ${i}`);
    }
    // Out-of-range index is rejected by the input schema or by the tool, never answered.
    let bad: CallToolResult | null = null;
    try {
      bad = await call('submit_answer', { sessionId, questionId: q1.questionId, displayIndex: 7 });
    } catch {
      // protocol-level rejection is fine
    }
    if (bad) {
      expect(bad.isError).toBe(true);
      expectClean(bad, 'bad index');
    }
  });
});

describe('strict public schemas', () => {
  const pub = {
    questionId: 'q_000000000001',
    position: 1,
    total: 3,
    stem: 's',
    options: [0, 1, 2, 3].map((i) => ({ index: i, label: 'ABCD'[i]!, text: `t${i}` })),
  };
  it('PublicQuestionViewSchema / assertPublicView reject every extra or forbidden key, at any depth', () => {
    expect(PublicQuestionViewSchema.parse(pub)).toEqual(pub);
    for (const k of ['correctIndex', 'correctDisplayIndex', 'explanation', 'refs', 'correctText', 'unknownKey']) {
      expect(() => PublicQuestionViewSchema.parse({ ...pub, [k]: 1 }), `top ${k}`).toThrow();
      expect(() => assertPublicView({ ...pub, [k]: 1 }), `assert top ${k}`).toThrow();
      expect(() => PublicQuestionViewSchema.parse({ ...pub, options: pub.options.map((o, i) => (i === 0 ? { ...o, [k]: 1 } : o)) }), `option ${k}`).toThrow();
    }
  });
  it('the MCP output schemas are strict at every level', () => {
    const out = StartQuizOutputSchema.parse({
      initialized: true,
      scanned: true,
      status: 'started',
      reason: null,
      session: { id: 'qs_0123456789abcdef', chunkId: LEAF, chunkTitle: 't', path: LEAF, total: 3, answered: 0, needed: 2, expiresAt: NOW.toISOString() },
      question: pub,
      result: null,
    });
    expect(() => StartQuizOutputSchema.parse({ ...out, correctIndex: 1 })).toThrow();
    expect(() => StartQuizOutputSchema.parse({ ...out, question: { ...pub, explanation: 'x' } })).toThrow();
    expect(() => StartQuizOutputSchema.parse({ ...out, session: { ...out.session, correctIndex: 1 } })).toThrow();
    const sub = {
      initialized: true,
      scanned: true,
      status: 'answered',
      reason: null,
      repeat: false,
      sessionId: 'qs_0123456789abcdef',
      reveal: null,
      progress: { answered: 1, total: 3, correct: 1 },
      next: pub,
      result: null,
    };
    expect(SubmitAnswerOutputSchema.safeParse(sub).success).toBe(true);
    expect(() => SubmitAnswerOutputSchema.parse({ ...sub, correctIndex: 1 })).toThrow();
    expect(() => SubmitAnswerOutputSchema.parse({ ...sub, next: { ...pub, explanation: 'x' } })).toThrow();
    expect(() => SubmitAnswerOutputSchema.parse({ ...sub, progress: { ...sub.progress, correctIndex: 1 } })).toThrow();
  });
});
