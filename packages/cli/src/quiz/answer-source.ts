// The testable seam of `gotchea quiz`: where answers come from. The command never talks to a
// terminal directly, so tests drive it with a `ScriptedAnswerSource` and no TTY.
import type { PublicQuestionView } from 'gotchea-core';

export type AnswerChoice = { kind: 'answer'; displayIndex: 0 | 1 | 2 | 3 } | { kind: 'quit' };

export interface AnswerSource {
  /** The presenter has already printed the position; this shows the prompt and returns the choice. */
  ask(question: PublicQuestionView): Promise<AnswerChoice>;
  /** Resume? Generate now? */
  confirm(message: string, initial?: boolean): Promise<boolean>;
}
