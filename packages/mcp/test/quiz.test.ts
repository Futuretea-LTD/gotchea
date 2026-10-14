// start_quiz / submit_answer end to end over an in-memory MCP transport (M3_DESIGN.md §7, §10.6).
import { readdir } from 'node:fs/promises';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, chunkLineCount, computeRepoId, seededRng, userPaths } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { StartQuizOutputSchema, SubmitAnswerOutputSchema } from '../src/schemas.js';
import { ASK_USER } from '../src/tools/quiz-text.js';
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
      expect(Object.keys(q).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total']);
      expect(q.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);

      const t = text(res);
      expect(t).toContain(q.stem);
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
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} } });
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
      expect(text(res)).toContain('Quiz complete');
      expect(JSON.stringify(res.structuredContent)).not.toContain('explanation');
    } finally {
      await c.close();
    }
  });

  it('cancelling the prompt abandons the session without scoring', async () => {
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} } });
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
    const c = await connect(fx.root, fx.env, { capabilities: { elicitation: {} } });
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
