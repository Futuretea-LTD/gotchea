import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitialized, loadConfig, runScan } from 'gotchea-core';
import { INIT_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { ScanInputSchema, ScanOutputSchema } from '../schemas.js';

export function registerScan(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'scan',
    {
      title: 'Scan repository',
      description:
        'Chunk the repository and update the map: detects added, changed, moved and removed chunks. Runs synchronously and may take a while on large repos.',
      inputSchema: ScanInputSchema,
      outputSchema: ScanOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) {
          return textResult(INIT_MESSAGE, { initialized: false, scanned: false, summary: null });
        }
        const config = await loadConfig(ctx.root);
        const { summary } = await runScan(ctx.root, { config, env: ctx.env });
        await ctx.reloadIndex();
        const { added, changed, moved, removed, total } = summary;
        return textResult(
          `Scan done: ${added} added, ${changed} changed, ${moved} moved, ${removed} removed (${total} chunks tracked).`,
          { initialized: true, scanned: true, summary },
        );
      }),
  );
}
