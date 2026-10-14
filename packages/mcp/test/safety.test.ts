import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { FsChunkStore, initConfig } from 'gotchea-core';
import { EXPLANATION, FLAGGED_STEM, connect, createFixture, createRepo, text } from './helpers.js';

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

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
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
