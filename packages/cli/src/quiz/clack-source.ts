// Interactive answer source on @clack/prompts. Needs a TTY; Ctrl-C quits the quiz.
import { confirm, isCancel, select } from '@clack/prompts';
import type { PublicQuestionView } from 'gotchea-core';
import type { AnswerChoice, AnswerSource } from './answer-source.js';

export class ClackAnswerSource implements AnswerSource {
  async ask(question: PublicQuestionView): Promise<AnswerChoice> {
    const picked = await select<number>({
      message: question.stem,
      options: question.options.map((o) => ({ value: o.index, label: `${o.label}) ${o.text}` })),
    });
    return isCancel(picked) ? { kind: 'quit' } : { kind: 'answer', displayIndex: picked as 0 | 1 | 2 | 3 };
  }

  async confirm(message: string, initial = true): Promise<boolean> {
    const yes = await confirm({ message, initialValue: initial });
    return !isCancel(yes) && yes;
  }
}

/** Both ends must be a terminal for the prompts to work. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
