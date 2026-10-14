// Scripted answer source: a predefined list of answers, so tests can drive `gotchea quiz` without a TTY.
import type { PublicQuestionView } from 'gotchea-core';
import type { AnswerChoice, AnswerSource } from './answer-source.js';

/** A display index, `'quit'`, or a function that picks one from the question (e.g. by option text). */
export type ScriptStep = 0 | 1 | 2 | 3 | 'quit' | ((question: PublicQuestionView) => 0 | 1 | 2 | 3 | 'quit');

export class ScriptedAnswerSource implements AnswerSource {
  /** Every question asked, in order. */
  readonly asked: PublicQuestionView[] = [];
  /** Every confirm message, in order. */
  readonly confirms: string[] = [];
  private step = 0;
  private confirmStep = 0;

  /** `confirmAnswers`: replies to `confirm`, in order (default: always no, so nothing is resumed or generated). */
  constructor(
    private readonly steps: readonly ScriptStep[],
    private readonly confirmAnswers: readonly boolean[] = [],
  ) {}

  async ask(question: PublicQuestionView): Promise<AnswerChoice> {
    this.asked.push(question);
    const next = this.steps[this.step++];
    if (next === undefined) throw new Error('ScriptedAnswerSource: ran out of answers');
    const choice = typeof next === 'function' ? next(question) : next;
    return choice === 'quit' ? { kind: 'quit' } : { kind: 'answer', displayIndex: choice };
  }

  async confirm(message: string): Promise<boolean> {
    this.confirms.push(message);
    return this.confirmAnswers[this.confirmStep++] ?? false;
  }
}
