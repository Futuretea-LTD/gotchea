// Optional MCP elicitation path for `start_quiz`. Never required: it runs only when the connected
// client advertises the `elicitation` capability, and any failure falls back to the plain two-tool
// flow, which works because sessions are server-side.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  abandonQuiz,
  assertPublicView,
  LABELS,
  sanitizeTerminalText,
  submitAnswer,
  type PublicQuestionView,
  type QuizOpsDeps,
  type RevealView,
  type SessionHeader,
  type SessionResultView,
  type SubmitRefusal,
} from 'gotchea-core';
import type { Messages } from '../i18n.js';
import { clip, elicitCodeLines, optionLines, revealPlain } from './quiz-text.js';

/** The SDK's default request timeout is 60 s; a person reading a question needs longer. */
export const ELICIT_TIMEOUT_MS = 600_000;
export const ELICIT_MESSAGE_MAX = 6000;
export const ELICIT_CODE_MAX_LINES = 40;

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
        oneOf: q.options.map((o) => ({ const: o.label, title: `${o.label}) ${clip(o.text)}` })),
      },
    },
    required: ['answer'],
  };
}

export async function elicitQuiz(
  server: McpServer,
  root: string,
  deps: QuizOpsDeps,
  header: SessionHeader,
  first: PublicQuestionView,
  messages: Messages,
  /** start_quiz's explicit includeCode, kept for every prompt of this call (a resumed session stores its own). */
  includeCode?: boolean,
): Promise<ElicitOutcome> {
  const reveals: RevealView[] = [];
  let question = assertPublicView(first);
  for (;;) {
    const previous = reveals.length > 0 ? `${revealPlain(reveals[reveals.length - 1]!, messages)}\n\n` : '';
    const code = elicitCodeLines(question.code, messages);
    const message = `${previous}Question ${question.position} of ${question.total}\n\n${code ? `${code}\n\n` : ''}${sanitizeTerminalText(question.stem)}\n\n${optionLines(question)}\n\nPick A, B, C or D below.`;
    if (message.length > ELICIT_MESSAGE_MAX || (question.code && question.code.endLine - question.code.startLine + 1 > ELICIT_CODE_MAX_LINES)) {
      return { kind: 'fallback', reveals, question };
    }
    let picked: string | undefined;
    try {
      // Validate the envelope here and the display choice below. elicitInput's schema
      // validation would reject legacy numeric choices before we could map them.
      const r = await server.server.request(
        { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema: questionSchema(question) } },
        ElicitResultSchema,
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
    // Accept the previous numeric schema for clients that cached it.
    const displayIndex = picked && /^[0-3]$/.test(picked) ? Number(picked) : (LABELS as readonly string[]).indexOf(picked ?? '');
    if (displayIndex < 0) return { kind: 'fallback', reveals, question };

    const sub = await submitAnswer(
      root,
      { sessionId: header.id, questionId: question.questionId, displayIndex, ...(includeCode !== undefined && { includeCode }) },
      deps,
    );
    if (sub.status === 'refused') return { kind: 'refused', reason: sub.reason, message: sub.message };
    reveals.push(sub.reveal);
    if (sub.status === 'completed') return { kind: 'completed', reveals, result: sub.result };
    question = assertPublicView(sub.next);
  }
}
