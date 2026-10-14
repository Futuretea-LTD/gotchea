// End to end through the MCP server (in-memory transport): init → scan → get_generation_tasks → save_questions →
// start_quiz → submit_answer for every question → get_map. The colour of the chunk must change and must be the
// one colour function applied to the real retrievability (M3_DESIGN.md §9.1, §10.6).
import { readFile, readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProgressStore, HEAT, computeRepoId, defaultConfig, elapsedDays, heatColor, initConfig, isInitialized, repoPaths, retrievability, seededRng, userPaths } from 'gotchea-core';
import { createServer } from '../src/index.js';
import { GetMapOutputSchema, SaveQuestionsOutputSchema, StartQuizOutputSchema, SubmitAnswerOutputSchema, type MapNodeOut } from '../src/schemas.js';
import { NOW, createRepo, text } from './helpers.js';

const CHUNK = 'src/big.ts#alpha';
const cfg = defaultConfig().score;
const DAY = 86_400_000;

/** alpha(x) runs `x += i * x` for i = 0..107: an input of 0 stays 0. All four pass the save-time validators. */
const mk = (stem: string, options: string[], explanation: string, extra: Record<string, unknown> = {}) => ({
  type: 'behavior',
  stem,
  options,
  correctIndex: 0,
  explanation,
  refs: [{ start: 2, end: 110 }],
  difficulty: 1,
  ...extra,
});
const QUESTIONS = [
  mk('What does alpha return when it is called with 0?', ['It returns 0', 'It returns 1', 'It returns 107', 'It returns NaN'], 'L2-L109 only ever multiply x by (1 + i), so 0 stays 0 and L110 returns it.'),
  mk('Which value comes out of the function for a zero argument once the loop is done?', ['The value zero, unchanged', 'The value one', 'The value one hundred and seven', 'A NaN produced by the loop'], 'Every iteration on L2-L109 scales x, so zero is a fixed point and L110 returns it.', { type: 'edge_case', difficulty: 2 }),
  mk('How does the accumulator behave across the loop body for an input of zero?', ['It stays at zero throughout', 'It grows by one each time', 'It jumps to 107 at the end', 'It turns into NaN midway'], 'Lines L2-L109 multiply x by a factor each step, so a zero accumulator never leaves zero.'),
  mk('What would a caller observe after alpha finishes with a zero input?', ['Zero comes back to the caller', 'One comes back to the caller', 'The loop count comes back', 'An exception is thrown instead'], 'L110 returns the accumulator, which L2-L109 never moved away from zero.', { type: 'edge_case', difficulty: 2 }),
];
const FIFTH = mk('If alpha receives zero, what is left in x when control reaches the end of the function?', ['Nothing but zero remains', 'Exactly one remains', 'The number 107 remains', 'Not-a-number remains'], 'L110 hands back x as the loop on L2-L109 left it, which for zero input is still zero.');
const CORRECT_TEXTS = new Map([...QUESTIONS, FIFTH].map((q) => [q.stem, q.options[q.correctIndex]!]));

let repo: Awaited<ReturnType<typeof createRepo>>;
let clock: { t: number };
let client: Client;
let close: () => Promise<unknown>;

async function connectWithClock(): Promise<void> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer({ root: repo.root, env: repo.env, now: () => new Date(clock.t), rng: seededRng(5) });
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  close = () => Promise.all([client.close(), server.close()]);
}
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;

beforeEach(async () => {
  repo = await createRepo();
  clock = { t: NOW.getTime() };
  await connectWithClock();
});
afterEach(async () => {
  await close();
  await repo.cleanup();
});

const find = (n: MapNodeOut, id: string): MapNodeOut | null => (n.id === id ? n : (n.children.map((c) => find(c, id)).find(Boolean) ?? null));
const mapOf = async (path?: string) => GetMapOutputSchema.parse((await call('get_map', path ? { path } : {})).structuredContent).root!;
const walk = (n: MapNodeOut): MapNodeOut[] => [n, ...n.children.flatMap(walk)];
const ancestorPath = (root: MapNodeOut, id: string): MapNodeOut[] => {
  const go = (n: MapNodeOut, acc: MapNodeOut[]): MapNodeOut[] | null => (n.id === id ? acc : (n.children.map((c) => go(c, [n, ...acc])).find(Boolean) ?? null));
  return go(root, [])!;
};

async function prepare(): Promise<{ chunkHash: string }> {
  // init (the CLI's `gotchea init` is core's initConfig), then the scan tool.
  expect(await isInitialized(repo.root)).toBe(false);
  expect(text(await call('get_map'))).toMatch(/gotchea init/);
  await initConfig(repo.root);
  expect(await isInitialized(repo.root)).toBe(true);
  expect(text(await call('get_map'))).toMatch(/scan/i);
  const scan = await call('scan');
  expect(scan.isError).toBeFalsy();

  const tasks = (await call('get_generation_tasks', { limit: 10 })).structuredContent as { tasks: { chunkId: string; chunkHash: string; count: number }[] };
  const task = tasks.tasks.find((t) => t.chunkId === CHUNK)!;
  expect(task).toBeDefined();
  const saved = await call('save_questions', { chunkId: CHUNK, chunkHash: task.chunkHash, questions: QUESTIONS });
  const out = SaveQuestionsOutputSchema.parse(saved.structuredContent);
  expect(out.rejected, JSON.stringify(out.rejected)).toEqual([]);
  expect(out.savedCount).toBe(QUESTIONS.length);

  // One short of the chunk's quiz size: start_quiz refuses, tells how to fix it, and starts nothing.
  const short = await call('start_quiz', { chunkId: CHUNK });
  expect(short.isError).toBe(true);
  expect(StartQuizOutputSchema.parse(short.structuredContent)).toMatchObject({ status: 'refused', reason: 'not_enough_questions', session: null, question: null });
  expect(find(await mapOf(), CHUNK)!.state.color).toBe('red');
  const more = SaveQuestionsOutputSchema.parse((await call('save_questions', { chunkId: CHUNK, chunkHash: task.chunkHash, questions: [FIFTH] })).structuredContent);
  expect(more.rejected, JSON.stringify(more.rejected)).toEqual([]);
  expect(more.usableQuestions).toBe(QUESTIONS.length + 1);
  return { chunkHash: task.chunkHash };
}

/** Picks the option whose text is the known right one (answer keys are unknown to the client). */
const pick = (q: { stem: string; options: { index: number; text: string }[] }, wrong = false): number => {
  const right = CORRECT_TEXTS.get(q.stem)!;
  return q.options.find((o) => (o.text === right) !== wrong)!.index;
};

async function playQuiz(wrongCount: number): Promise<{ result: NonNullable<ReturnType<typeof SubmitAnswerOutputSchema.parse>['result']>; texts: string[] }> {
  const startRes = await call('start_quiz', { chunkId: CHUNK });
  const start = StartQuizOutputSchema.parse(startRes.structuredContent);
  expect(start.status, text(startRes)).toBe('started');
  let q = start.question!;
  const texts: string[] = [];
  for (let n = 0; ; n++) {
    const res = await call('submit_answer', { sessionId: start.session!.id, questionId: q.questionId, displayIndex: pick(q, n < wrongCount) });
    expect(res.isError).toBeFalsy();
    texts.push(text(res));
    const out = SubmitAnswerOutputSchema.parse(res.structuredContent);
    expect(out.reveal!.correct).toBe(n >= wrongCount);
    if (out.status === 'completed') return { result: out.result!, texts };
    q = out.next!;
  }
}

describe('init → scan → save_questions → quiz → map', () => {
  it('turns the chunk from red to green, consistent with the real retrievability, then decays with time', async () => {
    await prepare();
    const repoId = await computeRepoId(repo.root);

    // Before: questions exist, never passed → red, R = 0 (not grey).
    const before = find(await mapOf(), CHUNK)!;
    expect(before.okQuestions).toBe(QUESTIONS.length + 1);
    expect(before.state).toMatchObject({ color: 'red', R: 0 });
    expect(text(await call('get_map'))).toContain(`${HEAT.red.emoji} alpha`);

    const { result, texts } = await playQuiz(0);
    expect(result).toMatchObject({ passed: true, correct: result.total, before: { color: 'red', R: 0 }, after: { color: 'green', R: 1 } });
    expect(result.heatmap.focus).toMatchObject({ id: CHUNK, color: 'green', R: 1 });
    expect(texts.at(-1)).toContain(`${HEAT.red.emoji} → ${HEAT.green.emoji}`);

    // After: get_map shows a different colour, equal to heatColor(R) with R from progress.json, not stored anywhere.
    const progress = (await new FsProgressStore(repoId, repo.env).load()).chunks[CHUNK]!;
    expect(progress.history).toHaveLength(1);
    const R = retrievability(progress.stability!, elapsedDays(progress.lastReviewedAt!, new Date(clock.t)), cfg);
    const after = find(await mapOf(), CHUNK)!;
    expect(after.state.color).not.toBe(before.state.color);
    expect(after.state.color).toBe('green');
    expect(after.state.color).toBe(heatColor(R, cfg));
    expect(after.state.R).toBeCloseTo(R, 10);
    expect(text(await call('get_map'))).toContain(`${HEAT.green.emoji} alpha`);
    const raw = await readFile(repoPaths(repo.root).chunks, 'utf8');
    expect(raw).not.toMatch(/"color"/); // no colour is persisted: it is always derived

    // The ancestors printed in the quiz result are the ones get_map reports (one function, same states).
    const root = await mapOf();
    const anc = ancestorPath(root, CHUNK);
    expect(result.heatmap.ancestors.map((a) => [a.id, a.color])).toEqual(anc.map((a) => [a.id, a.state.color]));
    for (const n of walk(root)) if (n.state.R !== null) expect(n.state.color, n.id).toBe(heatColor(n.state.R, cfg));

    // Decay with the injected clock: colours follow R(t), never an old stored value.
    const S = progress.stability!;
    for (const days of [10, 40, 200]) {
      clock.t = NOW.getTime() + days * DAY;
      const Rt = retrievability(S, days, cfg);
      const node = find(await mapOf(), CHUNK)!;
      expect(node.state.color, `day ${days}`).toBe(heatColor(Rt, cfg));
      expect(node.state.R).toBeCloseTo(Rt, 8);
    }
    // And the long-term state is not green any more.
    expect(find(await mapOf(), CHUNK)!.state.color).toBe('red');
    // Persistence layout sanity: sessions on disk are completed, nothing else was created in the repo dir.
    const sessionFiles = await readdir(userPaths(repoId, repo.env).sessionsDir);
    expect(sessionFiles).toHaveLength(1);
  });

  it('a failed quiz keeps the chunk red and marks it for re-passing', async () => {
    await prepare();
    const repoId = await computeRepoId(repo.root);
    const { result } = await playQuiz(QUESTIONS.length + 1); // everything wrong
    expect(result).toMatchObject({ passed: false, correct: 0, after: { color: 'red' } });
    const p = (await new FsProgressStore(repoId, repo.env).load()).chunks[CHUNK]!;
    expect(p.mustRepass).toBe(true);
    expect(p.history).toHaveLength(1);
    expect(find(await mapOf(), CHUNK)!.state.color).toBe('red');
    // A second, perfect quiz recovers.
    const second = await playQuiz(0);
    expect(second.result).toMatchObject({ passed: true, after: { color: 'green' } });
    expect((await new FsProgressStore(repoId, repo.env).load()).chunks[CHUNK]!.mustRepass).toBe(false);
    expect(find(await mapOf(), CHUNK)!.state.color).toBe('green');
  });

  it('the map has one fewer red leaf after the pass', async () => {
    await prepare();
    const reds = async () => walk(await mapOf()).filter((n) => n.isLeaf && n.state.color === 'red').length;
    const r0 = await reds();
    await playQuiz(0);
    expect(await reds()).toBe(r0 - 1);
  });
});
