import { expect } from 'vitest';
import type { GenerationTaskOut, MapNodeOut, StartQuizOut, SubmitAnswerOut } from '../../packages/mcp/src/schemas.js';
import type { McpHarness } from './harness.js';

export type ToolCaller = McpHarness['callTool'];
export const privateExplanationMarker = 'E2E_PRIVATE_EXPLANATION';
export interface Status {
  leaves: number;
  questions: number;
  colors: { grey: number; red: number; yellow: number; green: number };
}

// Distinct stems exercise real save validators without disabling dedupe or leak checks.
const cases = {
  'src/math.ts': [
    ['What happens when clamp receives inverted bounds?', ['A range error is thrown', 'The bounds are exchanged', 'The value is returned', 'The result becomes zero']],
    ['How does average handle an empty collection?', ['It returns null', 'It returns zero', 'It throws an error', 'It yields infinity']],
    ['What does clamp produce for a value above the upper bound?', ['The maximum bound', 'The minimum bound', 'The original value', 'An undefined value']],
    ['Which computation determines the average of a populated collection?', ['Sum divided by length', 'Sum multiplied by length', 'Largest minus smallest', 'First plus final element']],
    ['What result does clamp produce for an interior value?', ['The input remains unchanged', 'The lower bound is chosen', 'The upper bound is chosen', 'An exception is triggered']],
  ],
  'src/account.ts': [
    ['What happens when deposit receives a negative amount?', ['A range error is thrown', 'The balance is reduced', 'The amount is ignored', 'The account is closed']],
    ['How does withdraw respond to insufficient funds?', ['It returns false', 'It throws an error', 'It returns null', 'It yields infinity']],
    ['What effect does a valid deposit have on the stored balance?', ['The amount is added', 'The amount is deducted', 'The balance is doubled', 'The balance is cleared']],
    ['What does getBalance expose after account creation?', ['The current balance', 'The latest transaction', 'The configured overdraft', 'The deposit limit']],
    ['Which outcome follows a successful withdrawal?', ['Funds decrease and true returns', 'Funds increase and false returns', 'Funds stay and null returns', 'Funds reset and an error occurs']],
  ],
} as const;

export const correctTexts = new Map<string, string>(Object.values(cases).flatMap((bank) => bank.map(([stem, options]) => [stem, options[0]] as [string, string])));

export function fakeQuestions(task: GenerationTaskOut) {
  const bank = cases[task.chunkId as keyof typeof cases];
  expect(bank, `Unexpected fixture chunk ${task.chunkId}`).toBeDefined();
  expect(task.count).toBeGreaterThan(0);
  expect(task.count).toBeLessThanOrEqual(bank.length);
  return bank.slice(0, task.count).map(([stem, options], index) => ({
    type: task.typePlan[index]!, stem, options: [...options], correctIndex: 0,
    explanation: `${privateExplanationMarker}: L1-L${task.lineCount} implement the behavior exercised by this fixture scenario.`,
    refs: [{ start: 1, end: task.lineCount }], difficulty: 1,
  }));
}

export async function generateQuestions(call: ToolCaller): Promise<GenerationTaskOut[]> {
  const result = await call('get_generation_tasks', { limit: 10, lang: 'en' });
  const data = result.structuredContent as { tasks: GenerationTaskOut[]; remaining: number };
  expect(data.tasks.map((task) => task.chunkId).sort()).toEqual(Object.keys(cases).sort());
  expect(data.remaining).toBe(0);
  for (const task of data.tasks) {
    const questions = fakeQuestions(task);
    const saved = await call('save_questions', { chunkId: task.chunkId, chunkHash: task.chunkHash, lang: 'en', questions });
    expect(saved.structuredContent).toMatchObject({ status: 'saved', savedCount: questions.length, rejected: [] });
  }
  return data.tasks;
}

export async function mapNodes(call: ToolCaller): Promise<MapNodeOut[]> {
  const result = await call('get_map');
  const root = (result.structuredContent as { root: MapNodeOut | null }).root;
  expect(root).not.toBeNull();
  const walk = (node: MapNodeOut): MapNodeOut[] => [node, ...node.children.flatMap(walk)];
  return walk(root!);
}

export async function playQuiz(call: ToolCaller, chunkId: string, observe?: (question: NonNullable<StartQuizOut['question']>) => void) {
  const start = (await call('start_quiz', { chunkId, lang: 'en' })).structuredContent as StartQuizOut;
  expect(start.status).toBe('started');
  expect(start.session!.chunkId).toBe(chunkId);
  let question = start.question;
  for (let index = 0; index < start.session!.total; index++) {
    expect(question).not.toBeNull();
    observe?.(question!);
    const correctText = correctTexts.get(question!.stem);
    expect(correctText, question!.stem).toBeDefined();
    const option = question!.options.find((item) => item.text === correctText);
    expect(option).toBeDefined();
    const answer = (await call('submit_answer', {
      sessionId: start.session!.id, questionId: question!.questionId, displayIndex: option!.index,
    })).structuredContent as SubmitAnswerOut;
    expect(answer.reveal).toMatchObject({ questionId: question!.questionId, correct: true, correctText });
    if (index === start.session!.total - 1) {
      expect(answer.status).toBe('completed');
      expect(answer.next).toBeNull();
      expect(answer.result).toMatchObject({ passed: true, correct: start.session!.total, after: { color: 'green' } });
      return answer;
    }
    expect(answer.status).toBe('answered');
    question = answer.next;
  }
  throw new Error('Quiz did not complete');
}
