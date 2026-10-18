import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertPublicView, isInitialized, loadConfig, startQuiz } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { messagesFor } from '../i18n.js';
import { START_QUIZ_REASONS, StartQuizInputSchema, StartQuizOutputSchema, type StartQuizOut } from '../schemas.js';
import { clientCanElicit, elicitQuiz } from './elicit.js';
import { START_QUIZ_DESCRIPTION, resultText, revealBlock, startRefusal, startedText, submitRefusal } from './quiz-text.js';

const EMPTY = { status: null, reason: null, session: null, question: null, result: null } as const;

export function registerStartQuiz(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'start_quiz',
    {
      title: 'Start a quiz',
      description: START_QUIZ_DESCRIPTION,
      inputSchema: StartQuizInputSchema,
      outputSchema: StartQuizOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...EMPTY });
        const deps = await ctx.quiz();
        const res = await startQuiz(ctx.root, input, deps);

        if (res.status === 'refused') {
          if (res.reason === 'not_scanned') return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, ...EMPTY });
          // The SDK skips output validation on isError results; keep the strict-schema guarantee here.
          const reason = (START_QUIZ_REASONS as readonly string[]).includes(res.reason) ? (res.reason as StartQuizOut['reason']) : null;
          const out = StartQuizOutputSchema.parse({ initialized: true, scanned: true, ...EMPTY, status: 'refused', reason });
          return { ...textResult(startRefusal(res, input), out), isError: true };
        }

        // Read per call (ctx.quiz() reloads it), like get_map, so a questions.lang change applies without a restart.
        const config = deps.config ?? (await loadConfig(ctx.root));
        const messages = messagesFor(config.questions.lang);
        let { status, session, question } = res;
        let prefix = '';
        if (ctx.elicitation === 'auto' && clientCanElicit(server)) {
          const el = await elicitQuiz(server, ctx.root, deps, session, question, messages, input.includeCode);
          const base = { initialized: true, scanned: true } as const;
          if (el.kind === 'cancelled') {
            return textResult('Quiz cancelled. Nothing was scored.', { ...base, ...EMPTY, status: 'cancelled', session });
          }
          if (el.kind === 'completed') {
            const text = [...el.reveals.map((r, i) => `Question ${session.answered + i + 1}:\n${revealBlock(r, messages)}`), resultText(el.result, config.score.greenAt)].join('\n\n');
            const done = { ...session, answered: session.total };
            return textResult(text, { ...base, ...EMPTY, status: 'completed', session: done, result: el.result });
          }
          if (el.kind === 'refused') {
            const out = StartQuizOutputSchema.parse({ ...base, ...EMPTY, session });
            return { ...textResult(submitRefusal(el.reason, el.message, config.quiz.sessionTtlMinutes), out), isError: true };
          }
          // fallback: the plain flow continues at the first unanswered question.
          question = el.question;
          if (el.reveals.length > 0) {
            status = 'resumed';
            session = { ...session, answered: el.reveals.length };
            prefix = `${el.reveals.map((r) => revealBlock(r, messages)).join('\n\n')}\n\n`;
          }
        }
        // Core already checks the view; checked again here because this is where it leaves the process.
        question = assertPublicView(question);
        const out = { initialized: true, scanned: true, ...EMPTY, status, session, question };
        return textResult(`${prefix}${startedText(status, session, question, messages)}`, out);
      }),
  );
}
