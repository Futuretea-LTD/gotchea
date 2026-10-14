import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitialized, loadConfig, saveQuestions } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { SaveQuestionsInputSchema, SaveQuestionsOutputSchema, type SaveQuestionsOut } from '../schemas.js';

/** The client's self-reported name, stored on every question: printable and bounded. */
function hostLabel(name: string | undefined): string {
  const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return `host:${clean || 'unknown'}`;
}

const EMPTY = { status: null, reason: null, chunkId: null, savedCount: 0, accepted: [], rejected: [], usableQuestions: null, target: null };

export function registerSaveQuestions(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'save_questions',
    {
      title: 'Save generated questions',
      description:
        'Save questions you wrote for one task from get_generation_tasks. Pass the task chunkId and chunkHash unchanged. If the chunk is unknown or its code changed (hash mismatch), the whole call is refused and nothing is saved. Otherwise each question is validated and saved, and rejected ones come back as { index, reason, detail }. Fix those and resubmit only them.',
      inputSchema: SaveQuestionsInputSchema,
      outputSchema: SaveQuestionsOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ chunkId, chunkHash, lang, questions }) =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...EMPTY });
        await ctx.reconcile();
        const config = await loadConfig(ctx.root);
        const generatedBy = hostLabel(server.server.getClientVersion()?.name);
        const result = await saveQuestions(
          ctx.root,
          { chunkId, chunkHash, questions, ...(lang === undefined ? {} : { lang }) },
          { generatedBy, config, now: ctx.now(), env: ctx.env },
        );

        if (result.status === 'rejected') {
          if (result.reason === 'not_scanned') return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, ...EMPTY });
          // The SDK skips output validation on isError results; keep the strict-schema guarantee here.
          const out = SaveQuestionsOutputSchema.parse({ initialized: true, scanned: true, ...EMPTY, status: 'rejected', reason: result.reason, chunkId: result.chunkId });
          return { ...textResult(`gotchea: nothing saved (${result.reason}). ${result.message}`, out), isError: true };
        }

        // Indices, ids, reason codes and fixed-template details only (PLAN §6): nothing of the submission is echoed.
        const out: SaveQuestionsOut = {
          initialized: true,
          scanned: true,
          status: 'saved',
          reason: null,
          chunkId: result.chunkId,
          savedCount: result.accepted.length,
          accepted: result.accepted.map((a) => ({ index: a.index, id: a.id })),
          rejected: result.rejected.map((r) => ({ index: r.index, reason: r.reason, detail: r.detail })),
          usableQuestions: result.usableQuestions,
          target: result.target,
        };
        const lines = [`${out.savedCount} saved · ${out.rejected.length} rejected · pool ${result.usableQuestions}/${result.target} for ${result.chunkId}`];
        for (const r of out.rejected) lines.push(`- item ${r.index}: ${r.reason}: ${r.detail}`);
        if (out.rejected.length > 0) lines.push('Fix the rejected items and resubmit only those.');
        return textResult(lines.join('\n'), out);
      }),
  );
}
