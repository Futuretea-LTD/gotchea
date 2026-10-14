import { isAbsolute, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitialized, toPosixPath, type Chunk } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { GetChunkForFileInputSchema, GetChunkForFileOutputSchema, type ChunkInfo } from '../schemas.js';

function toInfo(c: Chunk): ChunkInfo {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    parentId: c.parentId,
    ranges: c.ranges.map((r) => ({ path: r.path, start: r.start, end: r.end })),
    loc: c.metrics.loc,
    complexity: c.metrics.complexity,
    fanIn: c.metrics.fanIn,
    isLeaf: c.isLeaf,
    questionCount: c.questionCount,
  };
}

/** Repo-relative POSIX path; absolute paths inside the root are accepted. */
function normalizePath(root: string, path: string): string {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return toPosixPath(rel).replace(/^\.\//, '');
}

function describe(c: Chunk): string {
  const r = c.ranges[0];
  const where = r ? ` (${r.path}${c.kind === 'file' ? '' : `:${r.start}-${r.end}`})` : '';
  return `${c.id} [${c.kind}]${where} · ${c.metrics.loc} LOC`;
}

export function registerGetChunkForFile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_chunk_for_file',
    {
      title: 'Chunk for file',
      description:
        'Find the chunk covering a file position. With `line`: the innermost chunk containing it. Without: the file chunk followed by its leaf chunks. Served from an in-memory index.',
      inputSchema: GetChunkForFileInputSchema,
      outputSchema: GetChunkForFileOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path, line }) =>
      guarded(async () => {
        if (!(await isInitialized(ctx.root))) {
          return textResult(INIT_MESSAGE, { initialized: false, scanned: false, chunks: [] });
        }
        await ctx.reconcile();

        const index = await ctx.index();
        if (!index) return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, chunks: [] });

        const rel = normalizePath(ctx.root, path);
        let found: Chunk[];
        if (line !== undefined) {
          const hit = index.lookup(rel, line);
          found = hit ? [hit] : [];
        } else {
          const file = index.fileChunk(rel);
          found = file ? [file, ...index.leavesUnder(file.id).filter((c) => c.id !== file.id)] : [];
        }
        const base = { initialized: true, scanned: true, chunks: found.map(toInfo) };
        if (found.length === 0) {
          return textResult(`No chunk for ${rel}${line === undefined ? '' : `:${line}`}. The file may be new or excluded; try \`scan\`.`, base);
        }
        return textResult(found.map(describe).join('\n'), base);
      }),
  );
}
