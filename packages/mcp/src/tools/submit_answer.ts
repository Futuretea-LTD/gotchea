import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertPublicView, isInitialized, loadConfig, submitAnswer } from 'gotchea-core';
import { INIT_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { messagesFor } from '../i18n.js';
import { SUBMIT_ANSWER_REASONS, SubmitAnswerInputSchema, SubmitAnswerOutputSchema, type SubmitAnswerOut } from '../schemas.js';
import { SUBMIT_ANSWER_DESCRIPTION, answeredText, resultText, revealBlock, submitRefusal } from './quiz-text.js';

const EMPTY = { status: null, reason: null, repeat: false, sessionId: null, reveal: null, progress: null, next: null, result: null } as const;

export function registerSubmitAnswer(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'submit_answer',
    {
      title: 'Submit a quiz answer',
      description: SUBMIT_ANSWER_DESCRIPTION,
      inputSchema: SubmitAnswerInputSchema,
      outputSchema: SubmitAnswerOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...EMPTY });
        await ctx.reconcile();
        const deps = await ctx.quiz();
        const config = deps.config ?? (await loadConfig(ctx.root));
        // Recorded and scored (under the repo lock) before anything is revealed.
        const res = await submitAnswer(ctx.root, input, deps);

        if (res.status === 'refused') {
          const reason = (SUBMIT_ANSWER_REASONS as readonly string[]).includes(res.reason) ? (res.reason as SubmitAnswerOut['reason']) : null;
          const out = SubmitAnswerOutputSchema.parse({ initialized: true, scanned: true, ...EMPTY, status: 'refused', reason });
          const text = submitRefusal(res.reason, res.message, config.quiz.sessionTtlMinutes);
          return { ...textResult(text, out), isError: true };
        }
        const messages = messagesFor(config.questions.lang);
        const base = { initialized: true, scanned: true, ...EMPTY, repeat: res.repeat, sessionId: res.sessionId, reveal: res.reveal, progress: res.progress } as const;
        if (res.status === 'answered') {
          // Core already checks the view; checked again here because this is where it leaves the process.
          const next = assertPublicView(res.next);
          const text = answeredText(res.sessionId, res.reveal, res.progress, next, messages);
          return textResult(text, { ...base, status: 'answered', next });
        }
        const text = `${revealBlock(res.reveal, messages)}\n\n${resultText(res.result, config.score.greenAt)}`;
        return textResult(text, { ...base, status: 'completed', result: res.result });
      }),
  );
}
