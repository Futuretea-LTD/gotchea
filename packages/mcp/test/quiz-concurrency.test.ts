// CLI and MCP writing to the same repository at the same time (M3_DESIGN.md §10.5.4): scan, quiz scoring
// and tool calls interleave through the repo lock without errors, lost progress or corrupt files.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, chunkLineCount, computeRepoId, inspectRepoLock, repoPaths, seededRng, userPaths } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { run, type CliIo } from '../../cli/src/program.js';
import { ScriptedAnswerSource } from '../../cli/src/quiz/scripted-source.js';
import { NOW, connect, createFixture, type Fixture } from './helpers.js';

const MATH = 'src/math.ts';
const STR = 'src/util/strings.ts';

let fx: Fixture;
beforeEach(async () => {
  fx = await createFixture();
});
afterEach(() => fx.cleanup());

async function seed(chunkId: string, tag: string): Promise<void> {
  const leaf = (await new FsChunkStore(fx.root).load())!.chunks.find((c) => c.id === chunkId)!;
  const qs: QuestionPrivate[] = Array.from({ length: 3 }, (_, i) => ({
    id: `q_${tag}${String(i + 1).padStart(11, '0')}`,
    chunkId,
    chunkHash: leaf.contentHash,
    chunkLines: chunkLineCount(leaf),
    type: 'behavior',
    stem: `${tag}-stem-${i}?`,
    options: [`${tag}${i}-a`, `${tag}${i}-correct`, `${tag}${i}-b`, `${tag}${i}-c`],
    correctIndex: 1,
    explanation: `${tag}-expl-${i}`,
    refs: [{ start: 1, end: 2 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(fx.root).save(chunkId, qs);
}

const cli = async (args: string[], deps?: Parameters<typeof run>[2]) => {
  let stdout = '';
  let stderr = '';
  const io: CliIo = { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), cwd: fx.root, env: fx.env, color: false, now: () => NOW };
  const code = await run(args, io, deps);
  return { code, stdout, stderr };
};
const rightIdx = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => o.text.endsWith('-correct'))!.index;
const scripted = (q: { options: { index: number; text: string }[] }) => rightIdx(q) as 0 | 1 | 2 | 3;

describe('concurrent CLI and MCP writers', () => {
  it('a CLI scan, a CLI quiz and two MCP calls (scan + final submit_answer) interleave safely, many times', async () => {
    await seed(MATH, 'a');
    await seed(STR, 'b');
    const conn = await connect(fx.root, fx.env, { rng: seededRng(31) });
    const call = async (name: string, args: Record<string, unknown>) => (await conn.client.callTool({ name, arguments: args })) as CallToolResult;
    try {
      for (let round = 0; round < 3; round++) {
        // An MCP quiz on MATH, answered up to the last question.
        const start = (await call('start_quiz', { chunkId: MATH })).structuredContent as { question: { questionId: string; options: { index: number; text: string }[] }; session: { id: string } };
        let q = start.question;
        const sessionId = start.session.id;
        for (let n = 0; n < 2; n++) {
          q = ((await call('submit_answer', { sessionId, questionId: q.questionId, displayIndex: rightIdx(q) })).structuredContent as { next: typeof q }).next;
        }
        // A file edit that the scans below must pick up.
        await writeFile(join(fx.root, 'py/app.py'), `def greet(name):\n    message = "hello " + name + "${round}"\n    return message\n`);

        const results = await Promise.all([
          call('submit_answer', { sessionId, questionId: q.questionId, displayIndex: rightIdx(q) }), // scores MATH under the lock
          cli(['quiz', STR], { answerSource: new ScriptedAnswerSource([scripted, scripted, scripted]), rng: seededRng(round + 1) }), // scores STR
          cli(['scan']),
          call('scan', {}),
          cli(['scan']),
        ]);

        const [submit, quiz, scanA, scanB, scanC] = results;
        expect((submit as CallToolResult).isError, JSON.stringify(submit)).toBeFalsy();
        expect((submit as CallToolResult).structuredContent).toMatchObject({ status: 'completed' });
        const quizRes = quiz as { code: number; stdout: string; stderr: string };
        expect(quizRes.code, quizRes.stderr).toBe(0);
        expect(quizRes.stdout).toMatch(/Quiz complete: 3\/3/);
        for (const r of [scanA, scanC] as { code: number; stderr: string }[]) expect(r.code, r.stderr).toBe(0);
        expect((scanB as CallToolResult).isError).toBeFalsy();

        // Both chunks gained exactly one history entry per round, and nothing else was lost.
        const repoId = await computeRepoId(fx.root);
        const progress = await new FsProgressStore(repoId, fx.env).load();
        expect(progress.chunks[MATH]!.history, `round ${round}`).toHaveLength(round + 1);
        expect(progress.chunks[STR]!.history, `round ${round}`).toHaveLength(round + 1);
        // New hash for py/app.py: tracked, chunks.json is well-formed and lists every file.
        const raw = await readFile(repoPaths(fx.root).chunks, 'utf8');
        expect(() => JSON.parse(raw)).not.toThrow();
        const ids = (await new FsChunkStore(fx.root).load())!.chunks.map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining([MATH, STR, 'py/app.py']));
        expect(await inspectRepoLock(repoId, fx.env)).toBeNull();
        expect((await readdir(userPaths(repoId, fx.env).repoDir)).filter((n) => n.startsWith('.lock'))).toEqual([]);
        // Pools untouched by the scans (same hashes still ok).
        expect((await new FsQuestionStore(fx.root).list(MATH)).filter((x) => x.status === 'ok')).toHaveLength(3);
      }
    } finally {
      await conn.close();
    }
  }, 120_000);
});
