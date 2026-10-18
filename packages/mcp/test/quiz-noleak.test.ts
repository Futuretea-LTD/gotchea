// Answer-key isolation over the whole pre-submit surface (PLAN.md §6, M3_DESIGN.md §10.3): no key,
// explanation or line reference, as a field or as a value, appears before the answer to that question
// was recorded; and the strict public schemas reject anything extra. A question's `code` preview is the
// chunk's own source: it may name `startLine`/`endLine` and say `correctIndex` in its text, never more.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_KEYS, FsChunkStore, PublicQuestionViewSchema, SessionSchema, assertPublicView, chunkLineCount, computeRepoId, initConfig, runScan, seededRng, userPaths } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { StartQuizOutputSchema, SubmitAnswerOutputSchema } from '../src/schemas.js';
import { ELICIT_MESSAGE_MAX } from '../src/tools/elicit.js';
import { DISPLAY_INSTRUCTIONS, RELAY_END, RELAY_RESULT_END, RELAY_RESULT_START, RELAY_START } from '../src/tools/quiz-text.js';
import { NOW, SOURCES, connect, createFixture, createRepo, seedLeaf, text, type Fixture } from './helpers.js';

const LEAF = 'src/math.ts';
const KEYS = [...new Set([...FORBIDDEN_KEYS, 'correctIndex', 'correctDisplayIndex', 'correctOptionIndex', 'correctText', 'explanation', 'refs', 'startLine', 'endLine'])];
/** Everything a `code` preview may hold; it alone may name line numbers before submit. */
const CODE_KEYS = ['endLine', 'language', 'path', 'startLine', 'text', 'truncated'];
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
/** Every value under a `code` key at any depth, skipping the subtrees named in `skip`. */
function codesOf(v: unknown, skip: ReadonlySet<string> = new Set(), out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) codesOf(x, skip, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (skip.has(k)) continue;
      if (k === 'code') out.push(x);
      else codesOf(x, skip, out);
    }
  }
  return out;
}
const everything = (res: CallToolResult): string => `${text(res)}\n${JSON.stringify(res.structuredContent ?? null)}`;

/** Key-only checks: a `code` subtree is a flat object of CODE_KEYS, and no forbidden key appears anywhere, inside it or not. */
function expectCleanKeys(value: unknown, label: string, skip: ReadonlySet<string> = new Set()): void {
  const keys = keysOf(value, new Set([...skip, 'code']));
  for (const k of KEYS) expect(keys, `${label}: key ${k}`).not.toContain(k);
  for (const code of codesOf(value, skip)) {
    expect(code, `${label}: code`).toBeTypeOf('object');
    expect(CODE_KEYS, `${label}: code keys`).toEqual(expect.arrayContaining(Object.keys(code as object)));
    for (const k of FORBIDDEN_KEYS) expect(keysOf(code), `${label}: code key ${k}`).not.toContain(k);
  }
}

function expectClean(res: CallToolResult, label: string, skip: ReadonlySet<string> = new Set()): void {
  expectCleanKeys(res.structuredContent, label, skip);
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
      ['includeCode: true', { chunkId: LEAF, includeCode: true }],
      ['includeCode: false', { chunkId: LEAF, includeCode: false }],
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
        const fields = args['includeCode'] === false ? ['options', 'position', 'questionId', 'stem', 'total'] : ['code', 'options', 'position', 'questionId', 'stem', 'total'];
        expect(Object.keys(out.question!).sort(), label).toEqual(fields);
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
      // A quiz tool's `code` is the preview; get_generation_tasks has its own `code` string, checked like any key.
      const quizTool = t.name === 'start_quiz' || t.name === 'submit_answer';
      const keys = keysOf(t.outputSchema, quizTool ? new Set([...skip, 'code']) : skip);
      for (const k of KEYS) expect(keys, `${t.name} output schema: ${k}`).not.toContain(k);
      if (quizTool) {
        // The code preview's schema is strict and names only the preview fields.
        const codes = codesOf(t.outputSchema, skip) as { properties: object; additionalProperties: unknown }[];
        expect(codes, t.name).toHaveLength(1);
        for (const code of codes) {
          expect(Object.keys(code.properties).sort(), `${t.name} code schema`).toEqual(CODE_KEYS);
          expect(code.additionalProperties, `${t.name} code schema`).toBe(false);
        }
      }
      const inKeys = keysOf(t.inputSchema);
      for (const k of KEYS) expect(inKeys, `${t.name} input schema: ${k}`).not.toContain(k);
    }
  });
});

describe('elicitation answer-key isolation', () => {
  it('each prompt and choice schema reveal only the preceding answer', async () => {
    await c.close();
    c = await connect(fx.root, fx.env, { rng: seededRng(21), elicitation: 'auto', capabilities: { elicitation: {} } });
    const order: number[] = [];
    const prompts: { message: string; requestedSchema: unknown }[] = [];
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      if (req.params.mode === 'url') throw new Error('Expected a form prompt');
      prompts.push(req.params);
      return { action: 'accept', content: { answer: 'A' } };
    });
    const res = await call('start_quiz', { chunkId: LEAF });
    const out = StartQuizOutputSchema.parse(res.structuredContent);
    expect(out.status).toBe('completed');
    for (const prompt of prompts) {
      const n = Number(/STEM-SENT-(\d+)/.exec(prompt.message)![1]);
      // Only the form's empty response field may be called `answer`; scan its definition too.
      const schema = prompt.requestedSchema as { properties: Record<string, unknown> };
      const { answer, ...otherProperties } = schema.properties;
      expectCleanKeys({ ...prompt, requestedSchema: { ...schema, properties: otherProperties } }, `prompt ${order.length + 1}`);
      expectCleanKeys(answer, `prompt ${order.length + 1} choices`);
      for (let other = 0; other < 4; other++) {
        if (other === order.at(-1)) expect(prompt.message).toContain(expl(other));
        else expect(JSON.stringify(prompt)).not.toContain(expl(other));
      }
      const choices = answer as { oneOf: { const: string; title: string }[] };
      expect(choices.oneOf.map((choice) => choice.const)).toEqual(['A', 'B', 'C', 'D']);
      for (const choice of choices.oneOf) {
        expect(choice.title).toMatch(new RegExp(`^[A-D]\\) OPT-${n}-[A-D]$`));
        expect(prompt.message).toContain(choice.title);
      }
      // Options from a future question must not be carried by the message or its titles.
      for (let other = 0; other < 4; other++) {
        if (other !== n && other !== order.at(-1)) expect(JSON.stringify(prompt)).not.toContain(`OPT-${other}-`);
      }
      order.push(n);
    }
    expect(order).toHaveLength(out.session!.total);
    expect(order.length).toBeGreaterThan(1);
  });

  it.each(['message', 'code'] as const)('the %s size guard returns a complete, clean text fallback before eliciting', async (limit) => {
    const target = limit === 'code' ? 'src/big.ts#alpha' : LEAF;
    const store = new FsQuestionStore(fx.root);
    const chunk = (await new FsChunkStore(fx.root).load())!.chunks.find((entry) => entry.id === target)!;
    const qs = (await store.list(LEAF)).map((q) => ({
      ...q,
      chunkId: target,
      chunkHash: chunk.contentHash,
      ...(limit === 'message' ? { stem: `${q.stem} ${'public question text '.repeat(400)}` } : {}),
    }));
    await store.save(target, qs);
    await c.close();
    c = await connect(fx.root, fx.env, { rng: seededRng(21), elicitation: 'auto', capabilities: { elicitation: {} } });
    let prompts = 0;
    c.client.setRequestHandler(ElicitRequestSchema, async () => {
      prompts++;
      return { action: 'cancel' };
    });
    const res = await call('start_quiz', { chunkId: target, count: 3 });
    expect(prompts).toBe(0);
    expectClean(res, `${limit} fallback`);
    const out = StartQuizOutputSchema.parse(res.structuredContent);
    expect(out.status).toBe('started');
    expect(text(res)).toContain(RELAY_START);
    expect(text(res)).toContain(RELAY_END);
    expect(text(res)).toContain(out.question!.stem);
    if (limit === 'message') expect(out.question!.stem.length).toBeGreaterThan(ELICIT_MESSAGE_MAX);
    expect(text(res)).toContain(out.question!.code!.text);
    for (const option of out.question!.options) expect(text(res)).toContain(`${option.label}) ${option.text}`);
  });
});

describe('full option text', () => {
  it('shows only the four shuffled options, in full and display order, with no answer hint', async () => {
    const store = new FsQuestionStore(fx.root);
    const qs = (await store.list(LEAF))!;
    for (const q of qs) q.options = [0, 1, 2, 3].map((j) => `OPT-${j}-${'z'.repeat(230)}\nsecond line ${j}`) as QuestionPrivate['options'];
    await store.save(LEAF, qs);
    const res = await call('start_quiz', { chunkId: LEAF });
    const q = StartQuizOutputSchema.parse(res.structuredContent).question!;
    const body = text(res).split(RELAY_START)[1]!.split(RELAY_END)[0]!;
    let at = -1;
    for (const o of q.options) {
      const idx = body.indexOf(`${o.label}) ${o.text.split('\n').join('\n    ')}`);
      expect(idx).toBeGreaterThan(at);
      at = idx;
    }
    expect(text(res)).not.toMatch(/EXPL-SENT|correctIndex|correctText/);
    expectClean(res, 'long options');
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
    // A forbidden or unknown key hidden inside `code` is caught too, even though `code` may name line numbers.
    const code = { path: LEAF, startLine: 1, endLine: 1, language: 'typescript', text: 'x' };
    const inCode = (extra: object) => ({ ...res, structuredContent: { ...res.structuredContent, next: { code: { ...code, ...extra } } } });
    expect(() => expectClean(inCode({}), 'code ok', new Set(['reveal']))).not.toThrow();
    for (const k of [...FORBIDDEN_KEYS, 'unknownKey']) expect(() => expectClean(inCode({ [k]: 1 }), `code ${k}`, new Set(['reveal']))).toThrow();
    expect(() => expectClean(inCode({ nested: { explanation: 'x' } }), 'code nested', new Set(['reveal']))).toThrow();
  });
});

describe('reveal timing', () => {
  // includeCode on start (stored on the session) and on submit (this response only) must not change what is revealed.
  it.each([
    ['default', {}, {}],
    ['includeCode: true', { includeCode: true }, { includeCode: true }],
    ['includeCode: false', { includeCode: false }, { includeCode: false }],
    ['start false, submit true', { includeCode: false }, { includeCode: true }],
  ] as [string, Record<string, unknown>, Record<string, unknown>][])("question k's explanation appears in no result returned before the answer to k was submitted (%s)", async (_, startArgs, submitArgs) => {
    const transcript: { label: string; res: CallToolResult }[] = [];
    const start = await call('start_quiz', { chunkId: LEAF, ...startArgs });
    expectClean(start, 'start');
    transcript.push({ label: 'start', res: start });
    const out = StartQuizOutputSchema.parse(start.structuredContent);
    const sessionId = out.session!.id;
    let q = out.question!;
    const order: string[] = [];
    for (;;) {
      order.push(q.questionId);
      const n = Number(q.questionId.slice(-12)) - 1; // seeded as q_…<i+1>
      const res = await call('submit_answer', { sessionId, questionId: q.questionId, displayIndex: 0, ...submitArgs });
      // This result may reveal exactly the question just answered, and no other.
      const body = everything(res);
      expect(body).toContain(expl(n));
      for (let other = 0; other < 4; other++) if (other !== n) expect(body, `answer to q${n} revealed q${other}`).not.toContain(expl(other));
      // And the `next` block of this very result is a clean public view.
      const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
      expectCleanKeys(parsed.next, `next after answer ${order.length}`);
      if (parsed.next) {
        expect(() => assertPublicView(parsed.next)).not.toThrow();
        expect('code' in parsed.next).toBe((submitArgs['includeCode'] ?? startArgs['includeCode'] ?? true) as boolean);
      }
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
  it('a code preview is accepted only with its own fields, at every level that carries a question', () => {
    const code = { path: LEAF, startLine: 1, endLine: 2, language: 'typescript', text: 'const correctIndex = 1;\nconst explanation = "x";' };
    const withCode = { ...pub, code };
    expect(PublicQuestionViewSchema.parse(withCode)).toEqual(withCode);
    expect(assertPublicView(withCode)).toEqual(withCode);
    expect(PublicQuestionViewSchema.parse({ ...pub, code: { ...code, truncated: true } }).code?.truncated).toBe(true);
    const session = { id: 'qs_0123456789abcdef', chunkId: LEAF, chunkTitle: 't', path: LEAF, total: 3, answered: 0, needed: 2, expiresAt: NOW.toISOString() };
    const start = { initialized: true, scanned: true, status: 'started', reason: null, session, question: withCode, result: null };
    const sub = { initialized: true, scanned: true, status: 'answered', reason: null, repeat: false, sessionId: session.id, reveal: null, progress: { answered: 1, total: 3, correct: 1 }, next: withCode, result: null };
    expect(StartQuizOutputSchema.safeParse(start).success).toBe(true);
    expect(SubmitAnswerOutputSchema.safeParse(sub).success).toBe(true);
    for (const k of [...FORBIDDEN_KEYS, 'unknownKey', 'stem', 'options']) {
      const bad = { ...withCode, code: { ...code, [k]: 1 } };
      expect(() => PublicQuestionViewSchema.parse(bad), `code ${k}`).toThrow();
      expect(() => assertPublicView(bad), `assert code ${k}`).toThrow();
      expect(StartQuizOutputSchema.safeParse({ ...start, question: bad }).success, `start code ${k}`).toBe(false);
      expect(SubmitAnswerOutputSchema.safeParse({ ...sub, next: bad }).success, `submit code ${k}`).toBe(false);
    }
    // `truncated` is a marker, never `false`; the line span must match the text.
    expect(PublicQuestionViewSchema.safeParse({ ...pub, code: { ...code, truncated: false } }).success).toBe(false);
    expect(PublicQuestionViewSchema.safeParse({ ...pub, code: { ...code, endLine: 5 } }).success).toBe(false);
  });
});

describe('code previews', () => {
  const mathLines = SOURCES[LEAF]!.split('\n');

  it('come with every question while the chunk is fresh, before the stem in the text', async () => {
    const start = await call('start_quiz', { chunkId: LEAF });
    const out = StartQuizOutputSchema.parse(start.structuredContent);
    let q = out.question!;
    for (;;) {
      expect(q.code, q.questionId).toBeDefined();
      expect(q.code!).toMatchObject({ path: LEAF, startLine: 1, language: 'typescript' });
      expect(q.code!.text.split('\n')).toEqual(mathLines.slice(0, q.code!.endLine));
      expect(q.code).not.toHaveProperty('truncated');
      const res = await call('submit_answer', { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 0 });
      expectClean(res, `answer ${q.questionId}`, new Set(['reveal']));
      const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
      if (parsed.status === 'completed') break;
      const t = text(res);
      // The next question's code sits between the reveal and the next stem.
      expect(t).toMatch(/Code: src\/math\.ts:1-\d+\n```typescript\nexport function clamp/);
      expect(t.lastIndexOf('export function clamp')).toBeLessThan(t.indexOf(parsed.next!.stem));
      q = parsed.next!;
    }
    expect(text(start)).toContain(`Code: src/math.ts:1-${out.question!.code!.endLine}`);
  });

  it('follow questions.lang for the header, like get_map', async () => {
    await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ questions: { lang: 'tr' } }));
    const res = await call('start_quiz', { chunkId: LEAF });
    const q = StartQuizOutputSchema.parse(res.structuredContent).question!;
    expect(text(res)).toContain(`Kod: src/math.ts:1-${q.code!.endLine}`);
    expect(text(res)).not.toContain('Code: ');
  });

  it('are left out when the source changed since generation (hash mismatch)', async () => {
    await writeFile(join(fx.root, LEAF), SOURCES[LEAF]!.replace('return n;', 'return n + 0;'));
    const start = await call('start_quiz', { chunkId: LEAF });
    expectClean(start, 'stale start');
    const out = StartQuizOutputSchema.parse(start.structuredContent);
    expect(out.status).toBe('started');
    expect(out.question).not.toHaveProperty('code');
    expect(text(start)).not.toMatch(/Code: |```|export function clamp/);
    const res = await call('submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
    const next = SubmitAnswerOutputSchema.parse(res.structuredContent).next!;
    expect(next).not.toHaveProperty('code');
    expect(text(res)).not.toMatch(/Code: |```|export function clamp/);
  });

  it('stop as soon as the source changes mid-quiz', async () => {
    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    expect(out.question!.code).toBeDefined();
    await writeFile(join(fx.root, LEAF), `// edited\n${SOURCES[LEAF]!}`);
    const res = await call('submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
    expectClean(res, 'edited mid-quiz', new Set(['reveal']));
    const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
    expect(parsed.status).toBe('answered');
    expect(parsed.next).not.toHaveProperty('code');
    expect(text(res)).not.toContain('// edited');
  });
});

describe('source that names the answer fields', () => {
  const PATH = 'src/answer-shape.ts';
  const SOURCE = [
    '// The stored question shape: the quiz must never send these fields, only this code.',
    'export interface Stored { correctIndex: number; explanation: string }',
    'export function grade(q: Stored, picked: number): string {',
    '  if (picked === q.correctIndex) return q.explanation;',
    "  return 'explanation hidden until correctIndex matches';",
    '}',
    '',
  ].join('\n');
  const RIGHT = (i: number) => `SHAPE-RIGHT-${i}`;
  const SHAPE_EXPL = (i: number) => `SHAPE-EXPL-${i}: grade returns the explanation only for the right pick.`;

  it('passes the leak checks, and neither the correct answer nor the explanation appears before submit', async () => {
    const repo = await createRepo();
    let conn: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await writeFile(join(repo.root, PATH), SOURCE);
      await initConfig(repo.root);
      await runScan(repo.root, { env: repo.env });
      const chunk = (await new FsChunkStore(repo.root).load())!.chunks.find((x) => x.id === PATH)!;
      expect(chunk.isLeaf).toBe(true);
      const qs: QuestionPrivate[] = Array.from({ length: 4 }, (_, i) => ({
        id: `q_${String(i + 1).padStart(12, '0')}`,
        chunkId: chunk.id,
        chunkHash: chunk.contentHash,
        chunkLines: SOURCE.split('\n').length - 1,
        type: 'behavior',
        stem: `SHAPE-STEM-${i}: what does grade return for a wrong pick?`,
        options: [`SHAPE-WRONG-${i}-a`, `SHAPE-WRONG-${i}-b`, `SHAPE-WRONG-${i}-c`, `SHAPE-WRONG-${i}-d`].map((o, j) => (j === i % 4 ? RIGHT(i) : o)) as QuestionPrivate['options'],
        correctIndex: (i % 4) as 0 | 1 | 2 | 3,
        explanation: SHAPE_EXPL(i),
        refs: [{ start: 4, end: 5 }],
        difficulty: 1,
        lang: 'en',
        generatedBy: 'test',
        promptVersion: 'p1',
        status: 'ok',
        flagged: false,
        verifiedBy: null,
        createdAt: NOW.toISOString(),
      }));
      await new FsQuestionStore(repo.root).save(chunk.id, qs);
      conn = await connect(repo.root, repo.env, { rng: seededRng(5) });
      const client = conn.client;

      /** Pre-submit checks for `q`, shown in `res` (with the previous reveal, if any, under `skip`). */
      const expectPreSubmitClean = (res: CallToolResult, q: { questionId: string; code?: { text: string } | undefined; options: { text: string }[] }, skip: ReadonlySet<string>, label: string) => {
        const n = Number(q.questionId.slice(-12)) - 1;
        expectCleanKeys(res.structuredContent, label, skip);
        expect(() => assertPublicView(q), label).not.toThrow();
        // The source really does say the words: a value-based scan would have flagged this view.
        expect(q.code?.text, label).toContain('correctIndex');
        expect(q.code?.text, label).toContain('explanation');
        expect(text(res), label).toContain('q.correctIndex');
        // The explanation of q is nowhere, and the right option is only one of four unmarked options.
        const all = everything(res);
        expect(all, label).not.toContain(SHAPE_EXPL(n));
        expect(all, label).not.toContain('SHAPE-EXPL');
        expect(q.code!.text, label).not.toContain('SHAPE-');
        expect(text(res).split(RIGHT(n)).length - 1, `${label}: right option shown once, as an option`).toBe(1);
        expect(q.options.map((o) => o.text)).toContain(RIGHT(n));
        const out = res.structuredContent as Record<string, unknown>;
        expect(JSON.stringify(skip.has('reveal') ? { ...out, reveal: null } : out).split(RIGHT(n)).length - 1, label).toBe(1);
      };

      const start = (await client.callTool({ name: 'start_quiz', arguments: { chunkId: PATH } })) as CallToolResult;
      const out = StartQuizOutputSchema.parse(start.structuredContent);
      expect(out.question!.code).toMatchObject({ path: PATH, startLine: 1, language: 'typescript' });
      expect(text(start)).not.toMatch(/Correct answer|Explanation:|Look at/);
      expectPreSubmitClean(start, out.question!, new Set(), 'start');

      let q = out.question!;
      for (;;) {
        const res = (await client.callTool({ name: 'submit_answer', arguments: { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 0 } })) as CallToolResult;
        const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
        // The reveal covers exactly the question just answered.
        const n = Number(q.questionId.slice(-12)) - 1;
        expect(parsed.reveal!.explanation).toBe(SHAPE_EXPL(n));
        if (parsed.status === 'completed') break;
        const next = parsed.next!;
        const m = Number(next.questionId.slice(-12)) - 1;
        expect(everything(res), 'next explanation').not.toContain(SHAPE_EXPL(m));
        expectCleanKeys(res.structuredContent, `next ${next.questionId}`, new Set(['reveal']));
        expect(() => assertPublicView(next)).not.toThrow();
        expect(next.code?.text).toContain('correctIndex');
        q = next;
      }
    } finally {
      await conn?.close();
      await repo.cleanup();
    }
  });
});

describe('answer-feedback block and excerpts', () => {
  const FEEDBACK = /Cited code|ANSWER FEEDBACK|excerpt/;

  /** The suite's seed says 4 chunk lines, which makes every ref approximate; excerpts need exact refs. */
  async function exactRefs(): Promise<void> {
    const store = new FsQuestionStore(fx.root);
    const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((x) => x.id === LEAF)!;
    await store.save(leaf.id, (await store.list(leaf.id)).map((q) => ({ ...q, chunkLines: chunkLineCount(leaf) })));
  }

  it('never appear in start_quiz, fresh or resumed', async () => {
    const fresh = await call('start_quiz', { chunkId: LEAF });
    expect(everything(fresh)).not.toMatch(FEEDBACK);
    const out = StartQuizOutputSchema.parse(fresh.structuredContent);
    await call('submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
    const resumed = await call('start_quiz', { chunkId: LEAF });
    expect(StartQuizOutputSchema.parse(resumed.structuredContent).status).toBe('resumed');
    expect(text(resumed)).not.toMatch(FEEDBACK);
    expect(JSON.stringify(resumed.structuredContent)).not.toMatch(FEEDBACK);
  });

  it('carry only the question just answered, and the next question block stays clean', async () => {
    await exactRefs();
    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    let q = out.question!;
    for (;;) {
      const n = Number(q.questionId.slice(-12)) - 1;
      const res = await call('submit_answer', { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 0 });
      const t = text(res);
      const block = t.slice(t.indexOf(RELAY_RESULT_START), t.indexOf(RELAY_RESULT_END));
      expect(t.split(RELAY_RESULT_START)).toHaveLength(2);
      expect(block).toContain(expl(n));
      expect(block).toContain('Cited code:\nsrc/math.ts:2-3');
      const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
      expect(parsed.reveal!.refs[0]!.excerpt).toBeDefined();
      if (parsed.status === 'completed') break;
      // Outside the feedback block, the next question's relay block holds neither refs, excerpt nor explanation.
      const nextBlock = t.slice(t.indexOf(RELAY_START), t.indexOf(RELAY_END));
      expect(nextBlock).not.toMatch(FEEDBACK);
      expect(nextBlock).not.toMatch(/EXPL-SENT/);
      expectCleanKeys(parsed.next, 'next');
      expect(JSON.stringify(parsed.next)).not.toMatch(FEEDBACK);
      q = parsed.next!;
    }
  });

  it('are absent from refused submits', async () => {
    const res = await call('submit_answer', { sessionId: 'qs_0123456789abcdef', questionId: 'q_000000000001', displayIndex: 0 });
    expect(res.isError).toBe(true);
    expect(everything(res)).not.toMatch(FEEDBACK);
  });

  it('server instructions and tool listings carry no sentinel', async () => {
    const instructions = c.client.getInstructions()!;
    expect(instructions).toBe(DISPLAY_INSTRUCTIONS);
    expect(instructions).not.toMatch(/EXPL-SENT|STEM-SENT|OPT-\d|correctIndex/);
  });

  it('keep the reveal ref schema strict: excerpt is explicit and takes no extra keys', async () => {
    await exactRefs();
    const { tools } = await c.client.listTools();
    type JsonSchema = { properties: Record<string, JsonSchema>; additionalProperties?: unknown; items: JsonSchema; anyOf?: JsonSchema[]; type?: string };
    const reveal = (tools.find((t) => t.name === 'submit_answer')!.outputSchema as unknown as JsonSchema).properties['reveal']!;
    const refItem = (reveal.anyOf ? reveal.anyOf.find((x) => x.type === 'object')! : reveal).properties['refs']!.items;
    expect(Object.keys(refItem.properties).sort()).toEqual(['approximate', 'endLine', 'excerpt', 'path', 'startLine']);
    expect(refItem.additionalProperties).toBe(false);
    expect(Object.keys(refItem.properties['excerpt']!.properties).sort()).toEqual(['language', 'text', 'truncated']);
    expect(refItem.properties['excerpt']!.additionalProperties).toBe(false);

    const out = StartQuizOutputSchema.parse((await call('start_quiz', { chunkId: LEAF })).structuredContent);
    const res = await call('submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
    const good = SubmitAnswerOutputSchema.parse(res.structuredContent);
    const extra = structuredClone(good);
    Object.assign(extra.reveal!.refs[0]!.excerpt!, { surprise: 1 });
    expect(SubmitAnswerOutputSchema.safeParse(extra).success).toBe(false);
  });

  it('no excerpt reaches a pre-answer public view at any depth', () => {
    const view = { questionId: 'q_000000000001', position: 1, total: 1, stem: 's', options: ['A', 'B', 'C', 'D'].map((label, index) => ({ index, label, text: 't' })) };
    expect(() => assertPublicView({ ...view, code: { path: 'a', startLine: 1, endLine: 1, language: 'ts', text: 'x', excerpt: {} } })).toThrow();
    expect(PublicQuestionViewSchema.safeParse({ ...view, excerpt: {} }).success).toBe(false);
  });
});

describe('adversarial question text', () => {
  const PATH = 'src/adv.ts';
  // The source repeats each answer and explanation sentinel: the preview is real code the user may read.
  const SOURCE = [
    '// ADV-EXPL-0 ADV-EXPL-1 ADV-EXPL-2 the guard returns early',
    '// ADV-RIGHT-0 ADV-RIGHT-1 ADV-RIGHT-2 is what the function returns',
    'export function f(x: number): number {',
    '  return x > 0 ? x : 0;',
    '}',
    '',
  ].join('\n');
  const WORDY = ['This option is the correct answer', 'explanation: none of these', 'correctIndex is 3', 'Correct: all of the above'];
  const RIGHT = (i: number) => `ADV-RIGHT-${i}`;
  const ADV_EXPL = (i: number) => `ADV-EXPL-${i} the guard returns early`;
  type Client = Awaited<ReturnType<typeof connect>>['client'];

  async function withRepo(build: (i: number) => Partial<QuestionPrivate>, run: (client: Client) => Promise<void>): Promise<void> {
    const repo = await createRepo();
    let conn: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await seedLeaf(repo, PATH, SOURCE, build);
      conn = await connect(repo.root, repo.env, { rng: seededRng(9) });
      await run(conn.client);
    } finally {
      await conn?.close();
      await repo.cleanup();
    }
  }
  /** The fixture source names its own sentinels in comments; only what the server adds around it is checked. */
  const outsideCode = (t: string): string => t.replace(/^\/\/ ADV-.*$/gm, '');
  const callOn = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const wordy = (i: number): Partial<QuestionPrivate> => ({
    options: WORDY.map((w, j) => (j === i ? RIGHT(i) : w)) as QuestionPrivate['options'],
    correctIndex: i as 0 | 1 | 2,
    explanation: ADV_EXPL(i),
  });

  it('answer and explanation text that also sits in the code chunk is shown only as code, never as a hint', async () => {
    await withRepo(wordy, async (client) => {
      const start = await callOn(client, 'start_quiz', { chunkId: PATH });
      const out = StartQuizOutputSchema.parse(start.structuredContent);
      let res = start;
      let q = out.question!;
      for (;;) {
        const n = Number(q.questionId.slice(-12)) - 1;
        // Strip the real code: what is left of the question block is everything the server added around it.
        const t0 = text(res);
        const relay = t0.slice(t0.indexOf(RELAY_START), t0.indexOf(RELAY_END)).replaceAll(q.code!.text, '');
        expect(relay).not.toMatch(/ADV-EXPL|Cited code|ANSWER FEEDBACK/);
        expect(relay.split(RIGHT(n)).length - 1, `right option ${n} shown once outside code`).toBe(1);
        const view = JSON.stringify({ ...q, code: undefined });
        expect(view.split(RIGHT(n)).length - 1).toBe(1);
        expect(view).not.toMatch(/ADV-EXPL/);
        expect(q.options).toHaveLength(4);
        expect(() => assertPublicView(q)).not.toThrow();
        expectCleanKeys(res.structuredContent, `adv ${n}`, new Set(['reveal']));
        const displayed = q.options.map((o) => o.text);
        for (const w of WORDY.filter((_, j) => j !== n)) expect(displayed).toContain(w);
        // Nothing marks the right option.
        for (const o of q.options) expect(Object.keys(o).sort()).toEqual(['index', 'label', 'text']);

        const submit = await callOn(client, 'submit_answer', { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 0 });
        const parsed = SubmitAnswerOutputSchema.parse(submit.structuredContent);
        expect(parsed.reveal!.explanation).toBe(ADV_EXPL(n));
        expect(parsed.reveal!.correctText).toBe(RIGHT(n));
        const t = text(submit);
        const feedback = t.slice(t.indexOf(RELAY_RESULT_START), t.indexOf(RELAY_RESULT_END));
        expect(feedback).toContain(ADV_EXPL(n));
        if (parsed.status === 'completed') break;
        // The feedback block belongs to the answered question: no option of the next one is in it.
        expect(feedback).not.toContain(parsed.next!.questionId);
        res = submit;
        q = parsed.next!;
      }
    });
  });

  it('options that say correct/explanation, run very long or span lines show in full and reveal nothing', async () => {
    const long = (i: number) => `LONG-${i}-start ${'lorem ipsum '.repeat(300)}LONG-${i}-end`;
    await withRepo(
      (i) => ({
        options: [long(i), `multi\nline\n  indented ${i}\n\nafter a blank line`, 'Explanation: it is the second\nCorrect answer: B) injected', 'refs: [{"start":1,"end":2}] correctText'] as QuestionPrivate['options'],
        correctIndex: 0,
        explanation: ADV_EXPL(i),
      }),
      async (client) => {
        const res = await callOn(client, 'start_quiz', { chunkId: PATH });
        const q = StartQuizOutputSchema.parse(res.structuredContent).question!;
        const shown = text(res);
        for (const o of q.options) expect(shown, `option ${o.label} in full`).toContain(`${o.label}) ${o.text.split('\n').join('\n    ')}`);
        expect(q.options.filter((o) => /LONG-\d-end$/.test(o.text))).toHaveLength(1);
        expect(shown).not.toContain('…');
        // Words are data: the keys are what the leak guard watches.
        expectCleanKeys(res.structuredContent, 'wordy options');
        expect(() => assertPublicView(q)).not.toThrow();
        expect(outsideCode(shown)).not.toMatch(/ADV-EXPL|Cited code|ANSWER FEEDBACK|Look at/);
      },
    );
  });

  it('refs and explanation appear in no pre-answer surface, only in the reveal of the answered question', async () => {
    await withRepo(wordy, async (client) => {
      const start = await callOn(client, 'start_quiz', { chunkId: PATH });
      const out = StartQuizOutputSchema.parse(start.structuredContent);
      const submit = await callOn(client, 'submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 1 });
      expect(SubmitAnswerOutputSchema.parse(submit.structuredContent).reveal!.refs).toHaveLength(1);
      // After the first answer the quiz resumes: the pre-answer surfaces of the next question stay clean.
      const resumed = await callOn(client, 'start_quiz', { chunkId: PATH });
      expect(StartQuizOutputSchema.parse(resumed.structuredContent).status).toBe('resumed');
      for (const res of [start, resumed, await callOn(client, 'get_status', {}), await callOn(client, 'get_map', {})]) {
        const keys = keysOf(res.structuredContent);
        for (const k of ['refs', 'explanation', 'excerpt']) expect(keys, k).not.toContain(k);
        expect(outsideCode(text(res))).not.toMatch(/ADV-EXPL|Cited code|ANSWER FEEDBACK|Look at/);
      }
      // Re-answering with a different pick is refused and must not turn the reveal into an oracle.
      const replay = await callOn(client, 'submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 2 });
      expect(text(replay)).toContain('already_answered');
      expect(everything(replay)).not.toMatch(/ADV-EXPL|Cited code|ANSWER FEEDBACK|excerpt/);
    });
  });
});
