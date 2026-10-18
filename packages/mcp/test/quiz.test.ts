// start_quiz / submit_answer end to end over an in-memory MCP transport (M3_DESIGN.md §7, §10.6).
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, chunkLineCount, computeRepoId, seededRng, userPaths } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { StartQuizOutputSchema, SubmitAnswerOutputSchema } from '../src/schemas.js';
import { messages } from '../src/i18n.js';
import { ASK_USER, RELAY_START, RELAY_END, ELICIT_TITLE_MAX, codeBlock, clip } from '../src/tools/quiz-text.js';
import { NOW, connect, createFixture, text, type Fixture } from './helpers.js';

const LEAF = 'src/math.ts';
const EXPLAIN = 'QZ-EXPLANATION: see the second guard.';
const FORBIDDEN = ['correctIndex', 'correctDisplayIndex', 'correctText', 'explanation', 'refs'];

let fx: Fixture;

/** `questionCount` questions whose correct option is the one whose text ends with `-correct`. */
async function seed(): Promise<void> {
  const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((c) => c.id === LEAF)!;
  const base = { chunkId: leaf.id, chunkHash: leaf.contentHash, type: 'behavior', difficulty: 1, lang: 'en', generatedBy: 'test', status: 'ok', flagged: false, chunkLines: chunkLineCount(leaf), promptVersion: 'p1', verifiedBy: null, createdAt: NOW.toISOString() } as const;
  const qs: QuestionPrivate[] = Array.from({ length: Math.max(3, leaf.questionCount) }, (_, i) => ({
    ...base,
    id: `q_${String(i + 1).padStart(12, '0')}`,
    stem: `QZ-STEM-${i + 1}: what happens in case ${i + 1}?`,
    options: [`q${i + 1}-wrong-a`, `q${i + 1}-correct`, `q${i + 1}-wrong-b`, `q${i + 1}-wrong-c`],
    correctIndex: 1,
    explanation: `${EXPLAIN} (${i + 1})`,
    refs: [{ start: 2, end: 3 }],
  }));
  await new FsQuestionStore(fx.root).save(leaf.id, qs);
}

beforeEach(async () => {
  fx = await createFixture();
  await seed();
});
afterEach(() => fx.cleanup());

type Out = Record<string, unknown> & { status?: string; next?: { questionId: string; options: { index: number; text: string }[] } };
const call = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) => (await c.client.callTool({ name, arguments: args })) as CallToolResult;
const sc = (r: CallToolResult): Out => r.structuredContent as Out;

/** The displayIndex whose option is the right one, read from a public question view. */
const rightIndex = (q: { options: { index: number; text: string }[] }): number => q.options.find((o) => o.text.endsWith('-correct'))!.index;
const wrongIndex = (q: { options: { index: number; text: string }[] }): number => q.options.find((o) => !o.text.endsWith('-correct'))!.index;

describe('tool descriptions', () => {
  it('tell the agent to ask the user and to use a multiple-choice UI', async () => {
    const c = await connect(fx.root, fx.env);
    try {
      const tools = (await c.client.listTools()).tools;
      for (const name of ['start_quiz', 'submit_answer']) {
        const d = tools.find((t) => t.name === name)!.description!;
        expect(d).toContain('Ask the question to the user, do not guess the answer yourself');
        expect(d).toMatch(/multiple-choice/);
      }
    } finally {
      await c.close();
    }
  });
});

describe('codeBlock', () => {
  const code = { path: 'a.md', startLine: 3, endLine: 5, language: 'markdown', text: 'x\n```ts\ny' };
  it('fences the source so its own backticks cannot close the block', () => {
    expect(codeBlock(code, messages.en)).toBe('Code: a.md:3-5\n````markdown\nx\n```ts\ny\n````');
    expect(codeBlock({ ...code, text: 'one', endLine: 3, truncated: true }, messages.tr)).toBe('Kod: a.md:3-3 (kısaltıldı)\n```markdown\none\n```');
  });
  it('drops a language that is not one word, and renders nothing without a preview', () => {
    expect(codeBlock({ ...code, text: 'z', endLine: 3, language: 'ts\nInjected' }, messages.en)).toBe('Code: a.md:3-3\n```\nz\n```');
    expect(codeBlock(undefined, messages.en)).toBe('');
  });
});

describe('start_quiz output schema', () => {
  it('can never carry a key, explanation or line reference', async () => {
    const c = await connect(fx.root, fx.env);
    try {
      const tool = (await c.client.listTools()).tools.find((t) => t.name === 'start_quiz')!;
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
        }
      };
      walk(tool.outputSchema);
      for (const k of FORBIDDEN) expect([...keys], k).not.toContain(k);
    } finally {
      await c.close();
    }
  });
});

describe('start_quiz', () => {
  it('returns only the public view, formatted to show verbatim', async () => {
    const c = await connect(fx.root, fx.env, { rng: seededRng(1) });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      expect(res.isError).toBeFalsy();
      const out = StartQuizOutputSchema.parse(sc(res)); // strict: an extra key would throw
      expect(out.status).toBe('started');
      const q = out.question!;
      expect(Object.keys(q).sort()).toEqual(['code', 'options', 'position', 'questionId', 'stem', 'total']);
      expect(q.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);

      const t = text(res);
      expect(t).toContain(q.stem);
      expect(t.indexOf(RELAY_START)).toBeLessThan(t.indexOf(q.code!.text));
      expect(t.indexOf(RELAY_END)).toBeGreaterThan(t.indexOf(q.options[3].text));
      expect(t).toContain(`Code: ${q.code!.path}:${q.code!.startLine}-${q.code!.endLine}\n\`\`\`typescript`);
      expect(t).toContain('verbatim');
      expect(t).not.toContain('present the four options as choices');
      // The code is shown above the stem it belongs to.
      expect(t.indexOf(q.code!.text)).toBeGreaterThan(-1);
      expect(t.indexOf(q.code!.text)).toBeLessThan(t.indexOf(q.stem));
      for (const o of q.options) expect(t).toContain(`${o.label}) ${o.text}`);
      expect(t).toContain(ASK_USER);
      expect(t).toContain('"displayIndex": <0-3>');
      expect(t).not.toContain(EXPLAIN);
      for (const k of FORBIDDEN) expect(JSON.stringify(res.structuredContent)).not.toContain(`"${k}"`);
      expect(t).not.toMatch(/explanation:|correctIndex|Look at:/i);
    } finally {
      await c.close();
    }
  });

  it('shows control and bidi characters in stored question text as stand-ins in the text, not in structuredContent', async () => {
    const evil = '\u001b]0;pwn\u0007\u202E';
    const store = new FsQuestionStore(fx.root);
    const qs = (await store.list(LEAF)).map((q) => ({ ...q, stem: `${q.stem} ${evil}`, options: q.options.map((o) => `${o} ${evil}`) as QuestionPrivate['options'], explanation: `${q.explanation} ${evil}` }));
    await store.save(LEAF, qs);
    const c = await connect(fx.root, fx.env, { rng: seededRng(1) });
    try {
      const started = await call(c, 'start_quiz', { chunkId: LEAF });
      const q = StartQuizOutputSchema.parse(sc(started)).question!;
      expect(q.stem).toContain(evil); // data stays as stored; JSON escapes it
      const answered = await call(c, 'submit_answer', { sessionId: (sc(started).session as { id: string }).id, questionId: q.questionId, displayIndex: wrongIndex(q) });
      for (const res of [started, answered]) {
        const t = text(res);
        expect(t).toContain('␛]0;pwn␇\\u{202E}');
        for (const ch of ['\u001b', '\u0007', '\u202E']) expect(t).not.toContain(ch);
      }
      expect(text(answered)).toMatch(/Explanation: .*␛\]0;pwn␇/);
    } finally {
      await c.close();
    }
  });

  it('refuses with both targets, an unknown chunk and a chunk without questions', async () => {
    const c = await connect(fx.root, fx.env);
    try {
      const both = await call(c, 'start_quiz', { path: 'src', chunkId: LEAF });
      expect(both.isError).toBe(true);
      expect(sc(both)).toMatchObject({ status: 'refused', reason: 'both_targets', question: null });
      const unknown = await call(c, 'start_quiz', { chunkId: 'nope.ts' });
      expect(sc(unknown)).toMatchObject({ reason: 'unknown_chunk' });
      const empty = await call(c, 'start_quiz', { path: 'py' });
      expect(sc(empty).reason).toMatch(/no_quizzable_chunk|no_match/);
    } finally {
      await c.close();
    }
  });
});

describe('includeCode', () => {
  const CODE = /Code: src\/math\.ts|export function clamp/;

  it('includeCode: false hides the preview, and submit_answer keeps the session value', async () => {
    const c = await connect(fx.root, fx.env, { rng: seededRng(2) });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF, includeCode: false });
      const out = StartQuizOutputSchema.parse(sc(res));
      expect(out.question!.code).toBeUndefined();
      expect(Object.keys(out.question!)).not.toContain('code');
      expect(text(res)).not.toMatch(CODE);

      const sub = await call(c, 'submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
      const next = SubmitAnswerOutputSchema.parse(sc(sub));
      expect(next.status).toBe('answered');
      expect(next.next!.code).toBeUndefined();
      expect(Object.keys(next.next!)).not.toContain('code');
      expect(text(sub)).not.toMatch(CODE);
    } finally {
      await c.close();
    }
  });

  it('includeCode on submit_answer overrides the session value for that response', async () => {
    await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ quiz: { showCode: false } }));
    const c = await connect(fx.root, fx.env, { rng: seededRng(2) });
    try {
      const out = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      expect(out.question).not.toHaveProperty('code');
      const sub = await call(c, 'submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0, includeCode: true });
      const next = SubmitAnswerOutputSchema.parse(sc(sub));
      expect(next.next!.code).toMatchObject({ path: LEAF });
      expect(text(sub)).toMatch(CODE);
      const resumed = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      expect(resumed.status).toBe('resumed');
      expect(resumed.question).not.toHaveProperty('code');
      const following = await call(c, 'submit_answer', { sessionId: out.session!.id, questionId: next.next!.questionId, displayIndex: 0 });
      expect(SubmitAnswerOutputSchema.parse(sc(following)).next).not.toHaveProperty('code');
      expect(text(following)).not.toMatch(CODE);
    } finally {
      await c.close();
    }
  });

  it('includeCode: true shows the preview on a resumed session started under quiz.showCode: false', async () => {
    await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ quiz: { showCode: false } }));
    const c = await connect(fx.root, fx.env, { rng: seededRng(2) });
    try {
      const off = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      expect(off.question!.code).toBeUndefined();
      await call(c, 'submit_answer', { sessionId: off.session!.id, questionId: off.question!.questionId, displayIndex: 0 });
      const res = await call(c, 'start_quiz', { chunkId: LEAF, includeCode: true });
      const out = StartQuizOutputSchema.parse(sc(res));
      expect(out.status).toBe('resumed');
      expect(out.question!.code).toMatchObject({ path: LEAF });
      expect(text(res)).toMatch(CODE);
    } finally {
      await c.close();
    }
  });

  it('includeCode: true on a new session overrides quiz.showCode: false for every question', async () => {
    await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ quiz: { showCode: false } }));
    const c = await connect(fx.root, fx.env, { rng: seededRng(2) });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF, includeCode: true });
      const out = StartQuizOutputSchema.parse(sc(res));
      expect(out.status).toBe('started');
      expect(out.question!.code).toMatchObject({ path: LEAF });
      expect(text(res)).toMatch(CODE);
      const sub = await call(c, 'submit_answer', { sessionId: out.session!.id, questionId: out.question!.questionId, displayIndex: 0 });
      const next = SubmitAnswerOutputSchema.parse(sc(sub));
      expect(next.next!.code).toMatchObject({ path: LEAF });
      expect(text(sub)).toMatch(CODE);
    } finally {
      await c.close();
    }
  });

  it('elicitation follows includeCode: false for every prompt', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'auto' });
    const seen: { message: string }[] = [];
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params as { message: string });
      return { action: 'accept', content: { answer: '0' } };
    });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF, includeCode: false });
      expect(sc(res).status).toBe('completed');
      expect(seen.length).toBeGreaterThan(1);
      for (const p of seen) expect(p.message).not.toMatch(CODE);
    } finally {
      await c.close();
    }
  });

  it('elicitation applies explicit includeCode: true over quiz.showCode: false to every prompt', async () => {
    await writeFile(join(fx.root, '.gotchea/config.json'), JSON.stringify({ quiz: { showCode: false } }));
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'auto' });
    const seen: string[] = [];
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params.message);
      return { action: 'accept', content: { answer: '0' } };
    });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF, includeCode: true });
      expect(sc(res).status).toBe('completed');
      expect(seen.length).toBeGreaterThan(1);
      for (const message of seen) expect(message).toMatch(CODE);
    } finally {
      await c.close();
    }
  });
});

describe('submit_answer', () => {
  it('reveals only after recording, and scores once after the last question', async () => {
    const c = await connect(fx.root, fx.env, { rng: seededRng(7) });
    try {
      const start = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      const sessionId = start.session!.id;
      const repoId = await computeRepoId(fx.root);
      const progress = () => new FsProgressStore(repoId, fx.env).load();
      let q = start.question!;
      const total = q.total;

      for (let n = 1; ; n++) {
        const res = await call(c, 'submit_answer', { sessionId, questionId: q.questionId, displayIndex: n === 1 ? wrongIndex(q) : rightIndex(q) });
        expect(res.isError).toBeFalsy();
        const out = SubmitAnswerOutputSchema.parse(sc(res));
        expect(out.reveal!.explanation).toContain(EXPLAIN);
        expect(text(res)).toContain(EXPLAIN);
        expect(out.reveal!.correct).toBe(n !== 1);
        expect(out.reveal!.refs).toEqual([expect.objectContaining({ path: LEAF, startLine: 2, endLine: 3, approximate: false })]);
        if (n === 1) expect(text(res)).toMatch(/❌ Incorrect[\s\S]*Correct answer: [A-D]\) q1-correct[\s\S]*Look at: src\/math\.ts L2–L3/);
        if (out.status === 'answered') {
          expect(n).toBeLessThan(total);
          expect(out.result).toBeNull();
          expect((await progress()).chunks[LEAF]).toBeUndefined(); // nothing scored mid-quiz
          q = out.next!;
          expect(text(res)).toContain(RELAY_START);
          expect(text(res)).toContain(`Code: ${q.code!.path}:${q.code!.startLine}-${q.code!.endLine}`);
          for (const o of q.options) expect(text(res)).toContain(`${o.label}) ${o.text}`);
          expect(text(res).indexOf(EXPLAIN)).toBeLessThan(text(res).indexOf(RELAY_START));
          continue;
        }
        expect(out.status).toBe('completed');
        expect(n).toBe(total);
        const r = out.result!;
        expect(r).toMatchObject({ passed: false, correct: total - 1, total });
        expect(r.before.color).toBe('red');
        expect(r.heatmap.focus.id).toBe(LEAF);
        expect(r.heatmap.fileLeaves.some((l) => l.isFocus)).toBe(true);
        expect(text(res)).toMatch(/Quiz complete: .*NOT PASSED/);
        expect(text(res)).toContain('🟥');
        expect((await progress()).chunks[LEAF]!.history).toHaveLength(1);
        break;
      }
    } finally {
      await c.close();
    }
  });

  it('shows the new colour and heatmap after a passing quiz, and refuses a replay', async () => {
    const c = await connect(fx.root, fx.env, { rng: seededRng(3) });
    try {
      const out = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      const sessionId = out.session!.id;
      let q = out.question!;
      let last: Out = {};
      for (;;) {
        const res = await call(c, 'submit_answer', { sessionId, questionId: q.questionId, displayIndex: rightIndex(q) });
        last = sc(res);
        if (last.status === 'completed') {
          expect(text(res)).toMatch(/PASSED/);
          expect(text(res)).toContain('🟥 → 🟩');
          expect(text(res)).toContain('Heatmap (src/math.ts)');
          break;
        }
        q = last.next as unknown as typeof q;
      }
      expect(last.result).toMatchObject({ passed: true, after: { color: 'green' } });
      const replay = await call(c, 'submit_answer', { sessionId, questionId: q.questionId, displayIndex: 0 });
      expect(replay.isError).toBe(true);
      expect(sc(replay)).toMatchObject({ status: 'refused', reason: 'session_completed', reveal: null });
    } finally {
      await c.close();
    }
  });

  it('refuses out-of-order and unknown answers without revealing anything', async () => {
    const c = await connect(fx.root, fx.env, { rng: seededRng(5) });
    try {
      const out = StartQuizOutputSchema.parse(sc(await call(c, 'start_quiz', { chunkId: LEAF })));
      const sessionId = out.session!.id;
      const bad = await call(c, 'submit_answer', { sessionId, questionId: 'q_ffffffffffff', displayIndex: 0 });
      expect(sc(bad)).toMatchObject({ reason: 'unknown_question', reveal: null });
      const ghost = await call(c, 'submit_answer', { sessionId: 'qs_0123456789abcdef', questionId: out.question!.questionId, displayIndex: 0 });
      expect(sc(ghost)).toMatchObject({ reason: 'unknown_session' });
      expect(`${text(bad)}${text(ghost)}`).not.toContain(EXPLAIN);
    } finally {
      await c.close();
    }
  });

  it('survives a server restart: sessions are recovered from disk', async () => {
    const first = await connect(fx.root, fx.env, { rng: seededRng(11) });
    const out = StartQuizOutputSchema.parse(sc(await call(first, 'start_quiz', { chunkId: LEAF })));
    const q = out.question!;
    await first.close();
    const files = await readdir(userPaths(await computeRepoId(fx.root), fx.env).sessionsDir);
    expect(files).toContain(`${out.session!.id}.json`);

    const second = await connect(fx.root, fx.env);
    try {
      const res = await call(second, 'submit_answer', { sessionId: out.session!.id, questionId: q.questionId, displayIndex: rightIndex(q) });
      expect(res.isError).toBeFalsy();
      expect(sc(res)).toMatchObject({ status: 'answered', reveal: { correct: true } });
      // start_quiz on the same target resumes it, with the same permutation.
      const again = StartQuizOutputSchema.parse(sc(await call(second, 'start_quiz', { chunkId: LEAF })));
      expect(again.status).toBe('resumed');
      expect(again.session!.id).toBe(out.session!.id);
    } finally {
      await second.close();
    }
  });
});

describe('elicitation (optional)', () => {
  const answerByTitle = (req: { params: object }, wantRight: boolean): string => {
    const props = ((req.params as { requestedSchema?: unknown }).requestedSchema as { properties: { answer: { oneOf: { const: string; title: string }[] } } }).properties;
    const hit = props.answer.oneOf.find((o) => o.title.endsWith('-correct') === wantRight)!;
    return hit.const;
  };

  it('is never used when the client lacks the capability', async () => {
    const c = await connect(fx.root, fx.env);
    try {
      expect(c.client.getServerCapabilities()).toBeDefined();
      const out = sc(await call(c, 'start_quiz', { chunkId: LEAF }));
      expect(out.status).toBe('started');
    } finally {
      await c.close();
    }
  });

  it('runs the whole quiz as enum prompts when the client advertises elicitation', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'auto' });
    const seen: unknown[] = [];
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params);
      return { action: 'accept', content: { answer: answerByTitle(req, true) } };
    });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      expect(res.isError).toBeFalsy();
      const out = StartQuizOutputSchema.parse(sc(res));
      expect(out).toMatchObject({ status: 'completed', result: { passed: true } });
      expect(out.question).toBeNull();
      expect(seen.length).toBe(out.session!.total);
      expect(JSON.stringify(seen[0])).not.toContain(EXPLAIN); // the prompt never carries a reveal for the first question
      // Each prompt shows the chunk's code above the stem.
      for (const p of seen as { message: string }[]) {
        expect(p.message).toMatch(/Code: src\/math\.ts:1-\d+\n\s*1 │ export function clamp/);
        expect(p.message.indexOf('export function clamp')).toBeLessThan(p.message.indexOf('QZ-STEM-'));
      }
      expect(text(res)).toContain('Quiz complete');
      expect(JSON.stringify(res.structuredContent)).not.toContain('explanation');
    } finally {
      await c.close();
    }
  });

  it('cancelling the prompt abandons the session without scoring', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'auto' });
    c.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      expect(sc(res).status).toBe('cancelled');
      expect(text(res)).toContain('Nothing was scored');
      expect((await new FsProgressStore(await computeRepoId(fx.root), fx.env).load()).chunks[LEAF]).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  it('falls back to the plain flow when elicitation fails', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'auto' });
    c.client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error('boom');
    });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      expect(res.isError).toBeFalsy();
      expect(sc(res).status).toBe('started');
      expect(text(res)).toContain(ASK_USER);
    } finally {
      await c.close();
    }
  });

  it('can be switched off', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} }, elicitation: 'off' });
    c.client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error('must not be called');
    });
    try {
      expect(sc(await call(c, 'start_quiz', { chunkId: LEAF })).status).toBe('started');
    } finally {
      await c.close();
    }
  });
});


describe('complete question display', () => {
  async function longOptions() {
    const store = new FsQuestionStore(fx.root);
    const qs = (await store.list(LEAF))!;
    for (const q of qs) q.options = q.options.map((_, i) => `Option ${i}: ${'detailed option text '.repeat(12)}\ncontinued ${i}`) as QuestionPrivate['options'];
    await store.save(LEAF, qs);
    return qs;
  }

  it('keeps long multiline options complete in every text question', async () => {
    await longOptions();
    const c = await connect(fx.root, fx.env);
    try {
      let res = await call(c, 'start_quiz', { chunkId: LEAF });
      const start = StartQuizOutputSchema.parse(sc(res));
      let q = start.question!;
      for (;;) {
        const t = text(res);
        for (const o of q.options) expect(t).toContain(`${o.label}) ${o.text}`);
        expect(t).toContain(RELAY_START);
        expect(t).toContain(RELAY_END);
        res = await call(c, 'submit_answer', { sessionId: start.session!.id, questionId: q.questionId, displayIndex: 0 });
        const sub = SubmitAnswerOutputSchema.parse(sc(res));
        if (!sub.next) break;
        q = sub.next;
      }
    } finally { await c.close(); }
  });

  it('shows full options in form messages with short single-line letter choices', async () => {
    const qs = await longOptions();
    const c = await connect(fx.root, fx.env, { elicitation: 'auto', capabilities: { elicitation: {} } });
    let prompts = 0;
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts++;
      if (req.params.mode === 'url') throw new Error('Expected a form prompt');
      const schema = req.params.requestedSchema as unknown as { properties: { answer: { oneOf: { const: string; title: string }[] } } };
      expect(schema.properties.answer.oneOf.map((o) => o.const)).toEqual(['A', 'B', 'C', 'D']);
      for (const o of schema.properties.answer.oneOf) {
        expect(Array.from(o.title).length).toBeLessThanOrEqual(3 + ELICIT_TITLE_MAX);
        expect(o.title).not.toMatch(/[\r\n]/);
        expect(o.title.endsWith('…')).toBe(true);
      }
      for (const option of qs[0]!.options) expect(req.params.message).toContain(option);
      expect(req.params.message).toMatch(/1 │ export function clamp/);
      expect(req.params.message).not.toContain('```');
      return { action: 'accept', content: { answer: 'A' } };
    });
    try {
      expect(sc(await call(c, 'start_quiz', { chunkId: LEAF })).status).toBe('completed');
      expect(prompts).toBeGreaterThan(1);
    } finally { await c.close(); }
  });

  it.each(['0', '2', 'Z', '', '4'])('maps legacy or invalid form selection %j safely', async (answer) => {
    const c = await connect(fx.root, fx.env, { elicitation: 'auto', capabilities: { elicitation: {} } });
    c.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { answer } }));
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      expect(sc(res).status).toBe(/^[0-3]$/.test(answer) ? 'completed' : 'started');
      if (!/^[0-3]$/.test(answer)) expect(text(res)).toContain(RELAY_START);
    } finally { await c.close(); }
  });

  it.each([undefined, 'off', 'on', 'auto'])('uses form elicitation only when opted in via env %j', async (mode) => {
    const env = { ...fx.env };
    delete env['GOTCHEA_MCP_ELICIT'];
    if (mode) env['GOTCHEA_MCP_ELICIT'] = mode;
    const c = await connect(fx.root, env, { capabilities: { elicitation: {} } });
    let prompts = 0;
    c.client.setRequestHandler(ElicitRequestSchema, async () => { prompts++; return { action: 'cancel' }; });
    try {
      const res = await call(c, 'start_quiz', { chunkId: LEAF });
      const enabled = mode === 'on' || mode === 'auto';
      expect(sc(res).status).toBe(enabled ? 'cancelled' : 'started');
      expect(prompts).toBe(enabled ? 1 : 0);
    } finally { await c.close(); }
  });

  it('clips every title uniformly by code points after collapsing whitespace', () => {
    expect(clip('  a\n b\t c  ')).toBe('a b c');
    expect(clip('😀'.repeat(70))).toBe(`${'😀'.repeat(59)}…`);
  });
});
