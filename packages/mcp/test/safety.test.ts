import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_KEYS as PUBLIC_VIEW_FORBIDDEN_KEYS, FsChunkStore, assertPublicView, chunkLineCount, initConfig, runScan, seededRng } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { StartQuizOutputSchema, SubmitAnswerOutputSchema } from '../src/schemas.js';
import { RELAY_END, RELAY_START } from '../src/tools/quiz-text.js';
import { EXPLANATION, FLAGGED_STEM, NOW, SOURCES, connect, createFixture, createRepo, text } from './helpers.js';

const CALLS: [string, Record<string, unknown>][] = [
  ['scan', {}],
  ['get_map', {}],
  ['get_map', { path: 'src', depth: 1 }],
  ['get_chunk_for_file', { path: 'src/math.ts' }],
  ['get_chunk_for_file', { path: 'src/math.ts', line: 2 }],
  ['get_status', {}],
  ['get_generation_tasks', {}],
  ['get_generation_tasks', { limit: 10 }],
];

const ALPHA = 'src/big.ts#alpha';

/** Valid for src/big.ts#alpha, with sentinel options and explanation that must never come back. */
const SUBMITTED = {
  type: 'behavior',
  stem: 'What does alpha return when it is called with 0?',
  options: ['SUBMIT-OPT-0 zero', 'SUBMIT-OPT-1 one', 'SUBMIT-OPT-2 two', 'SUBMIT-OPT-3 nan'],
  correctIndex: 0,
  explanation: 'SUBMIT-EXPL: L2-L109 only multiply x by (1 + i), so 0 stays 0.',
  refs: [{ start: 2, end: 110 }],
  difficulty: 1,
};
/** Rejected (the correct option is in the stem); its sentinels must not be echoed either. */
const LEAKING = {
  ...SUBMITTED,
  stem: 'Why is SUBMIT-OPT-LEAK-KEY what alpha returns for 0?',
  options: ['SUBMIT-OPT-LEAK-KEY', 'SUBMIT-OPT-X', 'SUBMIT-OPT-Y', 'SUBMIT-OPT-Z'],
};

const FORBIDDEN_KEYS = ['correctIndex', 'explanation', 'options', 'refs'];
const SENTINELS = [EXPLANATION, 'SEED-OPT-', 'SUBMIT-OPT-', 'SUBMIT-EXPL', 'SEED-FLAGGED-STEM', FLAGGED_STEM, 'second guard'];

function collectKeys(value: unknown, out = new Set<string>(), skip: ReadonlySet<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, out, skip);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (skip.has(k)) continue;
      out.add(k);
      collectKeys(v, out, skip);
    }
  }
  return out;
}

describe('not initialised', () => {
  const all: [string, Record<string, unknown>][] = [...CALLS, ['save_questions', { chunkId: ALPHA, chunkHash: 'h', questions: [SUBMITTED] }]];

  it('every tool answers with a `gotchea init` hint, never an error or a throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotchea-mcp-empty-'));
    const { client, close } = await connect(root);
    try {
      for (const [name, args] of all) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError, name).toBeFalsy();
        expect(text(res), name).toContain('gotchea init');
        expect((res.structuredContent as { initialized: boolean }).initialized).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it('a git repo without .gotchea behaves the same', async () => {
    const repo = await createRepo();
    const { client, close } = await connect(repo.root, repo.env);
    try {
      for (const [name, args] of all) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError, name).toBeFalsy();
        expect(text(res), name).toContain('gotchea init');
      }
    } finally {
      await close();
      await repo.cleanup();
    }
  });
});

describe('initialised but not scanned', () => {
  it('every read and generation tool answers with a scan hint and readiness flags, never a throw or a leak', async () => {
    const repo = await createRepo();
    await initConfig(repo.root);
    const { client, close } = await connect(repo.root, repo.env);
    try {
      const calls: [string, Record<string, unknown>][] = [
        ...CALLS.filter(([name]) => name !== 'scan'),
        ['save_questions', { chunkId: ALPHA, chunkHash: 'h', questions: [SUBMITTED] }],
      ];
      for (const [name, args] of calls) {
        const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
        expect(res.isError, name).toBeFalsy();
        expect(text(res), name).toContain('scan');
        expect(res.structuredContent, name).toMatchObject({ initialized: true, scanned: false });
        for (const k of FORBIDDEN_KEYS) expect([...collectKeys(res.structuredContent)], `${name} ${k}`).not.toContain(k);
        expect(JSON.stringify(res), name).not.toMatch(/SUBMIT-OPT-|SUBMIT-EXPL/);
      }
      // Nothing was written for the refused save.
      expect(await readdir(join(repo.root, '.gotchea', 'questions')).catch(() => [])).toEqual([]);
    } finally {
      await close();
      await repo.cleanup();
    }
  });
});

describe('answer-key isolation', () => {
  it('never exposes answer keys, explanations, options, refs or flagged stems', async () => {
    const fx = await createFixture();
    const { client, close } = await connect(fx.root, fx.env);
    try {
      const chunks = (await new FsChunkStore(fx.root).load())!.chunks;
      const chunkHash = chunks.find((c) => c.id === ALPHA)!.contentHash;
      const calls: [string, Record<string, unknown>][] = [
        ...CALLS,
        ['save_questions', { chunkId: ALPHA, chunkHash, questions: [SUBMITTED] }],
        ['save_questions', { chunkId: ALPHA, chunkHash, questions: [LEAKING] }],
        ['save_questions', { chunkId: ALPHA, chunkHash: 'stale', questions: [SUBMITTED] }],
        // After the save, alpha's own submitted stem comes back as an existing stem: that is allowed (stems are public).
        ['get_generation_tasks', { limit: 10 }],
      ];

      const { tools } = await client.listTools();
      const keys = new Set<string>();
      // The quiz tools name `options` (public) and, for submit_answer, the reveal fields (after the answer was
      // recorded) in their schemas by design; test/quiz.test.ts pins those schemas.
      for (const t of tools) if (t.name !== 'submit_answer' && t.name !== 'start_quiz') collectKeys(t.outputSchema, keys);
      // Every value the client can see, plus tool metadata. The two documented exceptions name the
      // submission fields by design: the save_questions input description and each task's instructions.
      let values = JSON.stringify(tools);
      // The quiz tool descriptions say that the explanation is revealed after submit; that sentence is by design.
      const exempt = (t: (typeof tools)[number]) =>
        t.name === 'save_questions'
          ? { ...t, inputSchema: null, description: null }
          : t.name === 'start_quiz' || t.name === 'submit_answer'
            ? { ...t, description: null, outputSchema: t.name === 'submit_answer' ? null : t.outputSchema }
            : t;
      let named = JSON.stringify(tools.map(exempt));
      const results: CallToolResult[] = [];
      for (const [name, args] of calls) {
        const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
        results.push(res);
        collectKeys(res.structuredContent, keys);
        values += JSON.stringify(res.content) + JSON.stringify(res.structuredContent);
        if (name === 'get_generation_tasks') {
          const sc = res.structuredContent as { tasks: { instructions: string }[] };
          named += JSON.stringify({ ...sc, tasks: sc.tasks.map((t) => ({ ...t, instructions: null })) });
          // The text repeats the instructions once, after the task blocks.
          named += text(res).split('--- Instructions')[0];
        } else {
          named += JSON.stringify(res.content) + JSON.stringify(res.structuredContent);
        }
      }

      expect(results.filter((r) => r.isError)).toHaveLength(1); // only the stale-hash save
      expect(values.length).toBeGreaterThan(1000);
      for (const k of FORBIDDEN_KEYS) expect([...keys], k).not.toContain(k);
      for (const s of SENTINELS) expect(values, s).not.toContain(s);
      // Whole words: the reason code `explanation_citation` is fine.
      expect(named).not.toMatch(/\bcorrectIndex\b/);
      expect(named).not.toMatch(/\bexplanation\b/);
    } finally {
      await close();
      await fx.cleanup();
    }
  });
});

describe('quiz tools', () => {
  const LEAF = 'src/math.ts';
  const QUIZ_EXPL = (i: number) => `QUIZ-EXPL-${i}: the second guard returns hi.`;
  const CODE_KEYS = ['endLine', 'language', 'path', 'startLine', 'text'];

  /** Four ok questions on src/math.ts with sentinel explanations; their keys live only on disk. */
  async function seedQuiz(root: string): Promise<void> {
    const leaf = (await new FsChunkStore(root).load())!.chunks.find((c) => c.id === LEAF)!;
    const qs: QuestionPrivate[] = Array.from({ length: 4 }, (_, i) => ({
      id: `q_${String(i + 1).padStart(12, '0')}`,
      chunkId: leaf.id,
      chunkHash: leaf.contentHash,
      chunkLines: chunkLineCount(leaf),
      type: 'behavior',
      stem: `QUIZ-STEM-${i}: what does clamp return in case ${i}?`,
      options: [`QUIZ-OPT-${i}-A`, `QUIZ-OPT-${i}-B`, `QUIZ-OPT-${i}-C`, `QUIZ-OPT-${i}-D`],
      correctIndex: (i % 4) as 0 | 1 | 2 | 3,
      explanation: QUIZ_EXPL(i),
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
    await new FsQuestionStore(root).save(leaf.id, qs);
  }

  /**
   * Runs one quiz to the end and returns every question view sent before its answer, each with the
   * full tool result it came in (the reveal of the previous answer excluded).
   */
  async function runQuiz(root: string, env: NodeJS.ProcessEnv, flags: { start?: boolean; submit?: boolean } = {}) {
    const { client, close } = await connect(root, env, { rng: seededRng(9) });
    const seen: { res: CallToolResult; question: { questionId: string; code?: unknown }; total: number }[] = [];
    const startArgs = flags.start === undefined ? {} : { includeCode: flags.start };
    const submitArgs = flags.submit === undefined ? {} : { includeCode: flags.submit };
    try {
      const start = (await client.callTool({ name: 'start_quiz', arguments: { chunkId: LEAF, ...startArgs } })) as CallToolResult;
      const out = StartQuizOutputSchema.parse(start.structuredContent);
      let q = out.question!;
      seen.push({ res: start, question: q, total: out.session!.total });
      for (;;) {
        const res = (await client.callTool({ name: 'submit_answer', arguments: { sessionId: out.session!.id, questionId: q.questionId, displayIndex: 1, ...submitArgs } })) as CallToolResult;
        const parsed = SubmitAnswerOutputSchema.parse(res.structuredContent);
        if (parsed.status === 'completed') break;
        q = parsed.next!;
        seen.push({ res, question: q, total: out.session!.total });
      }
    } finally {
      await close();
    }
    return seen;
  }

  it.each([
    ['default', {}, true],
    ['includeCode: true', { start: true, submit: true }, true],
    ['includeCode: false', { start: false, submit: false }, false],
    ['includeCode: false on start only', { start: false }, false],
  ] as [string, { start?: boolean; submit?: boolean }, boolean][])('send no forbidden key anywhere before an answer, inside a code preview included (%s)', async (_, flags, withCode) => {
    const fx = await createFixture();
    try {
      await seedQuiz(fx.root);
      const seen = await runQuiz(fx.root, fx.env, flags);
      // One pre-submit view per question of the session, never fewer.
      expect(seen.length).toBe(seen[0]!.total);
      expect(seen.length).toBeGreaterThan(1);
      for (const { res, question } of seen) {
        const label = question.questionId;
        // Everything but the reveal of the answer just recorded (which is allowed to name the key).
        const keys = [...collectKeys(res.structuredContent, new Set(), new Set(['reveal']))];
        for (const k of PUBLIC_VIEW_FORBIDDEN_KEYS) expect(keys, `${label} ${k}`).not.toContain(k);
        expect(() => assertPublicView(question), label).not.toThrow();
        if (withCode) {
          // Fresh chunk: the preview is there, flat, and holds only its own fields.
          expect(question.code, label).toBeDefined();
          expect(Object.keys(question.code as object).sort(), label).toEqual(CODE_KEYS);
          for (const k of PUBLIC_VIEW_FORBIDDEN_KEYS) expect([...collectKeys(question.code)], `${label} code ${k}`).not.toContain(k);
        } else {
          expect(question, label).not.toHaveProperty('code');
          expect(text(res), label).not.toMatch(/Code: /);
        }
        // The explanation of this question is nowhere in the result that asks it.
        const n = Number(label.slice(-12)) - 1;
        expect(JSON.stringify(res.content) + JSON.stringify(res.structuredContent), label).not.toContain(QUIZ_EXPL(n));
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('send no code preview once the source no longer matches the scanned chunk', async () => {
    const fx = await createFixture();
    try {
      await seedQuiz(fx.root);
      await writeFile(join(fx.root, LEAF), SOURCES[LEAF]!.replace('if (n < lo) return lo;', 'if (n <= lo) return lo;'));
      const seen = await runQuiz(fx.root, fx.env);
      // One pre-submit view per question of the session, never fewer.
      expect(seen.length).toBe(seen[0]!.total);
      expect(seen.length).toBeGreaterThan(1);
      for (const { res, question } of seen) {
        expect(question, question.questionId).not.toHaveProperty('code');
        expect(text(res), question.questionId).not.toMatch(/Code: |n <= lo/);
        const keys = [...collectKeys(res.structuredContent, new Set(), new Set(['reveal']))];
        for (const k of PUBLIC_VIEW_FORBIDDEN_KEYS) expect(keys, `${question.questionId} ${k}`).not.toContain(k);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

describe('quiz display treats source and question text as data', () => {
  it('escapes terminal controls, bidi and relay delimiters across text and elicitation surfaces', async () => {
    const fx = await createFixture();
    const unsafe = '\u001b[2J\u202e';
    const visible = '␛[2J\\u{202E}';
    const markers = `${RELAY_START} ${RELAY_END}`;
    const escapedMarkers = '‹‹‹SHOW TO USER VERBATIM SHOW TO USER VERBATIM›››';
    try {
      const path = 'src/math.ts';
      await writeFile(join(fx.root, path), `// ${unsafe} ${markers} ${'`'.repeat(5)}\n${SOURCES[path]!}`);
      await runScan(fx.root, { env: fx.env });
      const chunk = (await new FsChunkStore(fx.root).load())!.chunks.find((entry) => entry.id === path)!;
      const store = new FsQuestionStore(fx.root);
      const seeded = (await store.list(path))[0]!;
      await store.save(path, Array.from({ length: 3 }, (_, index) => ({
        ...seeded,
        id: `q_${String(index + 1).padStart(12, '0')}`,
        chunkHash: chunk.contentHash,
        status: 'ok' as const,
        flagged: false,
        stem: `Unsafe stem ${index} ${unsafe} ${markers}`,
        options: ['A', 'B', 'C', 'D'].map((label) => `Unsafe option ${label} ${unsafe} ${markers}`) as QuestionPrivate['options'],
      })));
      for (const elicitation of ['off', 'auto'] as const) {
        const conn = await connect(fx.root, fx.env, { elicitation, capabilities: { elicitation: {} } });
        let prompt: { message: string; requestedSchema: unknown } | undefined;
        conn.client.setRequestHandler(ElicitRequestSchema, async (req) => {
          if (req.params.mode === 'url') throw new Error('Expected a form prompt');
          prompt = req.params;
          return { action: 'cancel' };
        });
        try {
          const res = await conn.client.callTool({ name: 'start_quiz', arguments: { chunkId: path } });
          const shown = elicitation === 'auto' ? prompt!.message : text(res);
          expect(shown).not.toContain('\u001b');
          expect(shown).not.toContain('\u202e');
          expect(shown).toContain(visible);
          if (elicitation === 'off') {
            const relay = shown.slice(shown.indexOf(RELAY_START) + RELAY_START.length, shown.indexOf(RELAY_END));
            expect(relay).toContain(escapedMarkers);
            expect(relay).not.toContain(RELAY_START);
            expect(relay).not.toContain(RELAY_END);
            // A five-backtick source run needs a six-backtick fence.
            expect(relay).toContain('\n``````typescript\n');
            expect(relay).toContain('\n``````\n');
            expect(relay).toContain('Unsafe stem');
            for (const label of ['A', 'B', 'C', 'D']) expect(relay).toContain(`Unsafe option ${label}`);
          } else {
            expect(shown).toMatch(/1 │ \/\//);
            expect(shown).toContain('Unsafe stem');
            for (const label of ['A', 'B', 'C', 'D']) expect(shown).toContain(`Unsafe option ${label}`);
            const schema = JSON.stringify(prompt!.requestedSchema);
            expect(schema).not.toContain('\u001b');
            expect(schema).not.toContain('\u202e');
            expect(schema).toContain('␛[2J');
          }
        } finally {
          await conn.close();
        }
      }
    } finally {
      await fx.cleanup();
    }
  });
});
