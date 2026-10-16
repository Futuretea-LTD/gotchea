import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { StartQuizOut, SubmitAnswerOut } from '../../packages/mcp/src/schemas.js';
import { createHarness } from '../src/harness.js';
import { correctTexts, generateQuestions, mapNodes, playQuiz } from '../src/scenarios.js';

const epoch = '2030-01-01T00:00:00.000Z';
const day = 86_400_000;
const at = (days: number) => new Date(Date.parse(epoch) + days * day).toISOString();

it('D: overridden time follows R = 1 / (1 + t / (9S)): green → yellow → red', async (context) => {
  const harness = await createHarness({ now: epoch });
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const [task] = await generateQuestions(call);
    const directory = join(harness.fixture.root, '.gotchea/questions');
    const pools = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    const clockSupported = pools.every((pool) => pool.questions.every((question: { createdAt: string }) => question.createdAt === epoch));
    if (!clockSupported && (process.env['GOTCHEA_TARGET'] ?? 'local') !== 'local') {
      const message = 'Target does not honor GOTCHEA_NOW (persisted createdAt differs); deterministic time-decay verification unavailable.';
      await context.annotate(message, 'limitation');
      context.skip(message);
    }
    expect(clockSupported, 'Local target must honor GOTCHEA_NOW').toBe(true);
    const passed = await playQuiz(call, task!.chunkId);
    expect(passed.result!.stabilityDays).toBe(3);
    // Probe just before/after each threshold, avoiding equality/rounding ambiguity.
    const yellowDays = 9 * 3 * (1 / 0.85 - 1);
    const redDays = 9 * 3 * (1 / 0.5 - 1);
    for (const [days, color] of [[0, 'green'], [yellowDays - 0.01, 'green'], [yellowDays + 0.01, 'yellow'], [redDays - 0.01, 'yellow'], [redDays + 0.01, 'red']] as const) {
      await harness.restart(at(days));
      const node = (await mapNodes(call)).find((entry) => entry.id === task!.chunkId)!;
      expect(node.state.color, `elapsed=${days} days`).toBe(color);
      expect(node.state.R).toBeCloseTo(1 / (1 + days / 27), 7);
    }
  } finally { await harness.dispose(); }
});

it('D: repeated passes multiply stability by 2.5 and extend the green interval', async () => {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const [task] = await generateQuestions(call);
    let previous = (await playQuiz(call, task!.chunkId)).result!;
    expect(previous.stabilityDays).toBe(3);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = (await playQuiz(call, task!.chunkId)).result!;
      expect(current.stabilityDays).toBe(previous.stabilityDays! * 2.5);
      expect(Date.parse(current.after.dueAt!) - Date.parse(previous.after.dueAt!)).toBeGreaterThan(0);
      previous = current;
    }
  } finally { await harness.dispose(); }
});

it('D: below-threshold quizzes stay red and reduce previously earned stability', async () => {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const [task] = await generateQuestions(call);
    await playQuiz(call, task!.chunkId);
    const passed = await playQuiz(call, task!.chunkId);
    let stability = passed.result!.stabilityDays!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = (await call('start_quiz', { chunkId: task!.chunkId, lang: 'en' })).structuredContent as StartQuizOut;
      expect(start.status).toBe('started');
      let question = start.question!;
      let answer: SubmitAnswerOut | undefined;
      for (let index = 0; index < start.session!.total; index++) {
        const correct = correctTexts.get(question.stem);
        expect(correct).toBeDefined();
        // One correct answer remains below ceil(0.75 * total).
        const option = question.options.find((item) => index === 0 ? item.text === correct : item.text !== correct)!;
        answer = (await call('submit_answer', { sessionId: start.session!.id, questionId: question.questionId, displayIndex: option.index })).structuredContent as SubmitAnswerOut;
        question = answer.next!;
      }
      expect(answer!.status).toBe('completed');
      expect(answer!.result).toMatchObject({ passed: false, correct: 1, after: { color: 'red' } });
      expect(answer!.result!.correct).toBeLessThan(answer!.result!.needed);
      const reduced = Math.max(1, stability * 0.3);
      expect(answer!.result!.stabilityDays).toBeCloseTo(reduced);
      expect(reduced).toBeLessThan(stability);
      stability = reduced;
      expect((await mapNodes(call)).find((entry) => entry.id === task!.chunkId)!.state.color).toBe('red');
    }
  } finally { await harness.dispose(); }
});
