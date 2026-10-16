import { isAbsolute, basename, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { copyMapNode, filterTree, isInitialized, loadConfig, loadMapTree, renderHeatCell, toPosixPath, type MapNode } from 'gotchea-core';
import { INIT_MESSAGE, SCAN_MESSAGE, guarded, textResult, type ToolContext } from '../context.js';
import { messagesFor } from '../i18n.js';
import { GetMapInputSchema, GetMapOutputSchema, type MapNodeOut } from '../schemas.js';

/** Shared with `map --json` and `gotchea serve`: schema fields only, cut `depth` levels below `node`. */
const toOut = (node: MapNode, depth: number | undefined): MapNodeOut => copyMapNode(node, depth);

function leaves(node: MapNodeOut, out: MapNodeOut[] = []): MapNodeOut[] {
  if (node.isLeaf) out.push(node);
  for (const c of node.children) leaves(c, out);
  return out;
}

/** Usable questions over all leaves below each node, from the uncut tree (so `depth` doesn't hide them). */
function questionSums(node: MapNode, out = new Map<string, number>()): Map<string, number> {
  let sum = node.isLeaf ? node.okQuestions : 0;
  for (const c of node.children) sum += questionSums(c, out).get(c.id) ?? 0;
  out.set(node.id, sum);
  return out;
}

function summaryLine(full: MapNodeOut, messages: ReturnType<typeof messagesFor>): string {
  const ls = leaves(full);
  const questions = ls.reduce((n, l) => n + l.okQuestions, 0);
  let next: string;
  if (questions === 0) next = messages.generateQuestions;
  else if (ls.some((l) => l.state.color === 'grey' || l.state.color === 'red')) next = messages.takeQuiz;
  else if (ls.some((l) => l.state.color === 'yellow')) next = messages.reviewYellow;
  else next = messages.allGreen;
  return messages.mapSummary(ls.length, questions, next);
}

function renderTree(node: MapNodeOut, level: number, lines: string[], sums: ReadonlyMap<string, number>, messages: ReturnType<typeof messagesFor>): void {
  const name = node.kind === 'module' ? `${node.title}/` : node.title;
  // Parents carry no questions of their own; show the sum over all leaves below, even past the `depth` cut.
  const sum = sums.get(node.id) ?? 0;
  const q = node.isLeaf ? ` · ${messages.questionCount(node.okQuestions)}` : sum > 0 ? ` · Σ ${messages.questionCount(sum)}` : '';
  lines.push(`${'  '.repeat(level)}${renderHeatCell(node.state.color, 'emoji')} ${name} · ${node.loc} LOC${q}`);
  for (const c of node.children) renderTree(c, level + 1, lines, sums, messages);
}

/** Repo-relative chunk filter from a user path (directory, file or chunk id). */
function toFilter(root: string, path: string): string {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  const clean = toPosixPath(rel).replace(/^\.\//, '').replace(/\/+$/, '');
  return clean === '' ? '.' : clean;
}

export function registerGetMap(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_map',
    {
      title: 'Comprehension map',
      description:
        'The comprehension heat map: repo > module > file > symbol, with colour (⬜ unseen, 🟥, 🟨, 🟩), LOC and question counts. Optionally filtered by path and limited in depth.',
      inputSchema: GetMapInputSchema,
      outputSchema: GetMapOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path, depth }) =>
      guarded(async () => {
        const empty = { filter: null, depth: null, root: null };
        if (!(await isInitialized(ctx.root))) {
          return textResult(INIT_MESSAGE, { initialized: false, scanned: false, ...empty });
        }
        const config = await loadConfig(ctx.root);
        const snapshot = await loadMapTree(ctx.root, { config, env: ctx.env, now: ctx.now() });
        if (!snapshot?.root) return textResult(SCAN_MESSAGE, { initialized: true, scanned: false, ...empty });

        const full = snapshot.root;
        // chunks.json titles the root '.'; show the directory name like the CLI does.
        full.title = basename(ctx.root);
        const filter = path === undefined ? null : toFilter(ctx.root, path);
        const tree = filter === null ? full : filterTree(full, filter);
        if (!tree) {
          return textResult(`No chunks match ${filter}.`, { initialized: true, scanned: true, filter, depth: depth ?? null, root: null });
        }
        const root = toOut(tree, depth);
        const messages = messagesFor(config.questions.lang);
        const lines = [summaryLine(toOut(full, undefined), messages)];
        renderTree(root, 0, lines, questionSums(tree), messages);
        return textResult(lines.join('\n'), { initialized: true, scanned: true, filter, depth: depth ?? null, root });
      }),
  );
}
