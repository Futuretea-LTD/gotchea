// Optional MCP elicitation path for `start_quiz`. Never required: it runs only when the connected
// client advertises the `elicitation` capability, and any failure falls back to the plain two-tool
// flow, which works because sessions are server-side.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  abandonQuiz,
  submitAnswer,
  type PublicQuestionView,
  type QuizOpsDeps,
  type RevealView,
  type SessionHeader,
  type SessionResultView,
  type SubmitRefusal,
} from 'gotchea-core';
import { revealText } from './quiz-text.js';

/** The SDK's default request timeout is 60 s; a person reading a question needs longer. */
export const ELICIT_TIMEOUT_MS = 600_000;

/** Capabilities are known only after the handshake, so this is checked per call. */
export function clientCanElicit(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation?.form !== undefined;
}

export type ElicitOutcome =
  | { kind: 'completed'; reveals: RevealView[]; result: SessionResultView }
  | { kind: 'cancelled' }
  | { kind: 'refused'; reason: SubmitRefusal; message: string }
  /** Elicitation failed (method not found, timeout, transport): continue with the plain flow at `question`. */
  | { kind: 'fallback'; reveals: RevealView[]; question: PublicQuestionView };

/** One flat enum field: a titled single-select, which clients render as radio buttons or a menu. */
export function questionSchema(q: PublicQuestionView) {
  return {
    type: 'object' as const,
    properties: {
      answer: {
        type: 'string' as const,
        title: 'Your answer',
        oneOf: q.options.map((o) => ({ const: String(o.index), title: `${o.label}) ${o.text}` })),
      },
    },
    required: ['answer'],
  };
}

export async function elicitQuiz(server: McpServer, root: string, deps: QuizOpsDeps, header: SessionHeader, first: PublicQuestionView): Promise<ElicitOutcome> {
  const reveals: RevealView[] = [];
  let question = first;
  for (;;) {
    const previous = reveals.length > 0 ? `${revealText(reveals[reveals.length - 1]!)}\n\n` : '';
    let picked: string | undefined;
    try {
      const r = await server.server.elicitInput(
        { mode: 'form', message: `${previous}Question ${question.position} of ${question.total}\n\n${question.stem}`, requestedSchema: questionSchema(question) },
        { timeout: ELICIT_TIMEOUT_MS },
      );
      if (r.action !== 'accept') {
        await abandonQuiz(header.id, deps);
        return { kind: 'cancelled' };
      }
      picked = typeof r.content?.['answer'] === 'string' ? r.content['answer'] : undefined;
    } catch {
      return { kind: 'fallback', reveals, question };
    }
    const displayIndex = Number(picked);
    if (!Number.isInteger(displayIndex)) return { kind: 'fallback', reveals, question };

    const sub = await submitAnswer(root, { sessionId: header.id, questionId: question.questionId, displayIndex }, deps);
    if (sub.status === 'refused') return { kind: 'refused', reason: sub.reason, message: sub.message };
    reveals.push(sub.reveal);
    if (sub.status === 'completed') return { kind: 'completed', reveals, result: sub.result };
    question = sub.next;
  }
}
