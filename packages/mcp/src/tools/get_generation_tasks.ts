import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LangCodeSchema, buildUserPrompt, getGenerationTasks, isInitialized, loadConfig, renderHostInstructions, type GenerationTask } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { GetGenerationTasksInputSchema, GetGenerationTasksOutputSchema, type GenerationTaskOut } from '../schemas.js';

const DEFAULT_LIMIT = 3;

/** Copies only schema fields (never spreads): stems of usable questions, nothing else from the pool. */
function toOut(t: GenerationTask): GenerationTaskOut {
  return {
    chunkId: t.chunkId,
    chunkHash: t.chunkHash,
    path: t.path,
    title: t.title,
    sourceLang: t.sourceLang,
    lineCount: t.lineCount,
    code: t.code,
    context: {
      imports: t.context.imports.map((i) => ({ from: i.from, name: i.name, signature: i.signature })),
      enclosing: t.context.enclosing,
    },
    existingStems: [...t.existingStems],
    count: t.count,
    typePlan: [...t.typePlan],
    questionLang: t.questionLang,
    instructions: renderHostInstructions(t),
  };
}

function summary(tasks: readonly GenerationTask[], remaining: number, changed: readonly string[]): string {
  const parts = [`${tasks.length} task${tasks.length === 1 ? '' : 's'}`, `${remaining} more chunk${remaining === 1 ? '' : 's'} need questions`];
  if (changed.length > 0) parts.push(`${changed.length} skipped (edited since the last scan; run scan)`);
  return parts.join(' · ');
}

export function registerGetGenerationTasks(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_generation_tasks',
    {
      title: 'Question generation tasks',
      description:
        'The next chunks that need quiz questions, highest priority first (no questions yet, most imported, largest gap). Each task has chunk-relative numbered code, import signatures, the stems of existing questions and the instructions. Write the questions yourself, then call save_questions. Best done in a subagent or a separate session, so the answers you write stay out of the context you are quizzed in.',
      inputSchema: GetGenerationTasksInputSchema,
      outputSchema: GetGenerationTasksOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ limit, lang }) =>
      guarded(async () => {
        const empty = { tasks: [], remaining: 0, changedSinceScan: [] };
        if (!(await isInitialized(ctx.root))) return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...empty });
        await ctx.reconcile();
        if (lang !== undefined && !LangCodeSchema.safeParse(lang).success) {
          return { isError: true, content: [{ type: 'text', text: `gotchea: invalid lang ${JSON.stringify(lang)}; use a code such as en, tr or pt-BR.` }] };
        }
        const config = await loadConfig(ctx.root);
        const result = await getGenerationTasks(ctx.root, { config, limit: limit ?? DEFAULT_LIMIT, ...(lang === undefined ? {} : { lang }) });
        if (!result) return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, ...empty });

        const { tasks, remaining, changedSinceScan } = result;
        const head = summary(tasks, remaining, changedSinceScan);
        const structured = { initialized: true, scanned: true, tasks: tasks.map(toOut), remaining, changedSinceScan: [...changedSinceScan] };
        if (tasks.length === 0) {
          return textResult(changedSinceScan.length > 0 ? head : 'Every chunk has a full question pool. Nothing to generate.', structured);
        }
        // Clients that ignore structuredContent can still act on the text alone.
        const body = tasks.map((t, i) => `--- Task ${i + 1}: chunkId ${t.chunkId} · chunkHash ${t.chunkHash}\n\n${buildUserPrompt(t)}`);
        return textResult([head, ...body, `--- Instructions (one save_questions call per task, with that task's chunkId and chunkHash)\n\n${renderHostInstructions(tasks[0]!)}`].join('\n\n'), structured);
      }),
  );
}
