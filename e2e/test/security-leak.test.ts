import { expect, it } from 'vitest';
import { FORBIDDEN_KEYS } from '../../packages/core/src/quiz/views.js';
import type { GenerationTaskOut, StartQuizOut } from '../../packages/mcp/src/schemas.js';
import { createHarness } from '../src/harness.js';
import { fakeQuestions, generateQuestions, playQuiz, privateExplanationMarker, type ToolCaller } from '../src/scenarios.js';

const forbidden = new Set<string>(FORBIDDEN_KEYS);

function assertNoAnswerKeys(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    expect(value, `Private explanation leaked at ${path}`).not.toContain(privateExplanationMarker);
    // Some MCP implementations put the payload only in content[].text.
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { return; }
    assertNoAnswerKeys(decoded, `${path}<json>`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertNoAnswerKeys(entry, `${path}[${index}]`); });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      expect(forbidden.has(key), `Answer key leaked at ${path}.${key}`).toBe(false);
      assertNoAnswerKeys(entry, `${path}.${key}`);
    }
  }
}

it('C: leak detector rejects every forbidden key nested in arrays and JSON text', () => {
  for (const key of FORBIDDEN_KEYS) {
    expect(() => assertNoAnswerKeys({ content: [{ text: JSON.stringify({ nested: [{ [key]: 0 }] }) }] })).toThrow('Answer key leaked');
  }
});

it('C: no pre-answer tool response contains an answer key, including populated pools and active quizzes', async () => {
  const harness = await createHarness();
  const checked = new Set<string>();
  const call: ToolCaller = async (name, args) => {
    const result = await harness.callTool(name, args);
    assertNoAnswerKeys(result);
    checked.add(name);
    return result;
  };
  try {
    await call('scan');
    await call('get_map');
    await call('get_status');
    await call('get_chunk_for_file', { path: 'src/math.ts', line: 2 });
    const tasks = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
    expect(tasks.tasks).toHaveLength(2);
    for (const task of tasks.tasks) {
      const questions = fakeQuestions(task);
      const save = async (items: typeof questions) => {
        const result = await call('save_questions', { chunkId: task.chunkId, chunkHash: task.chunkHash, lang: 'en', questions: items });
        expect(result.structuredContent).toMatchObject({ savedCount: items.length, rejected: [] });
      };
      await save(questions.slice(0, 1));
      const partial = (await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] };
      expect(partial.tasks.find((entry) => entry.chunkId === task.chunkId)!.existingStems).toEqual([questions[0]!.stem]);
      await save(questions.slice(1));
    }
    // Rejected items must not echo private fields either.
    const first = tasks.tasks[0]!;
    const duplicate = await call('save_questions', {
      chunkId: first.chunkId, chunkHash: first.chunkHash, lang: 'en', questions: [{ invalid: true }],
    });
    expect(duplicate.structuredContent).toMatchObject({ savedCount: 0, rejected: [{ reason: 'schema_invalid' }] });
    for (const task of tasks.tasks) {
      const start = await call('start_quiz', { chunkId: task.chunkId, lang: 'en' });
      expect(start.structuredContent).toMatchObject({ status: 'started', question: { options: expect.any(Array) } });
      await call('get_chunk_for_file', { path: task.path });
      await call('get_map');
      await call('get_status');
      await call('get_generation_tasks', { limit: 10, lang: 'en' });
    }
    expect([...checked].sort()).toEqual(['scan', 'get_map', 'get_status', 'get_chunk_for_file', 'get_generation_tasks', 'save_questions', 'start_quiz'].sort());
  } finally {
    await harness.dispose();
  }
});

it('C: fresh sessions shuffle options for the same question rather than reusing a fixed order', async () => {
  const harness = await createHarness();
  const call = harness.callTool.bind(harness);
  try {
    await call('scan');
    const [task] = await generateQuestions(call);
    const orders = new Map<string, Set<string>>();
    const sessions = new Set<string>();
    // Finish each session so resume semantics cannot masquerade as a shuffle failure.
    // Eight independent draws have <= 24^-7 probability of all matching for one question.
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await playQuiz(call, task!.chunkId, (question: NonNullable<StartQuizOut['question']>) => {
        assertNoAnswerKeys(question);
        const seen = orders.get(question.questionId) ?? new Set<string>();
        seen.add(JSON.stringify(question.options.map((option) => option.text)));
        orders.set(question.questionId, seen);
      });
      sessions.add(result.sessionId!);
    }
    expect(sessions.size).toBe(8);
    expect(orders.size).toBe(task!.count);
    for (const [id, seen] of orders) expect(seen.size, `Fixed option order for ${id}`).toBeGreaterThan(1);
  } finally {
    await harness.dispose();
  }
});
