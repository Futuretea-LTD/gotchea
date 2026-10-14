import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HEAT, getStatus, isInitialized } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { GetStatusInputSchema, GetStatusOutputSchema } from '../schemas.js';

const ZERO = { chunks: 0, leaves: 0, questions: 0, due: 0, colors: { grey: 0, red: 0, yellow: 0, green: 0 } };

export function registerGetStatus(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_status',
    {
      title: 'Comprehension status',
      description: 'Tracked chunk count, question count, reviews due now and the colour distribution of the leaf chunks.',
      inputSchema: GetStatusInputSchema,
      outputSchema: GetStatusOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) {
          return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...ZERO });
        }
        const s = await getStatus(ctx.root, { env: ctx.env, now: ctx.now() });
        if (!s.scanned) return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, ...ZERO });
        const { chunks, leaves, questions, due, colors } = s;
        const text =
          `${chunks} chunks (${leaves} leaves) · ${questions} questions · ${due} due · ` +
          `${HEAT.grey.emoji} ${colors.grey} ${HEAT.red.emoji} ${colors.red} ${HEAT.yellow.emoji} ${colors.yellow} ${HEAT.green.emoji} ${colors.green}`;
        return textResult(text, { initialized: true, scanned: true, chunks, leaves, questions, due, colors });
      }),
  );
}
