// The machine-readable map and status shapes shared by `gotchea map --json`,
// `gotchea status --json`, MCP `get_map` and the `gotchea serve` API. Written once here;
// every node is copied field by field, so nothing outside the MapNode schema (and no
// answer data) can ride along.
import type { StatusReport } from '../ops/status.js';
import type { MapSnapshot } from './load.js';
import { filterTree, type MapNode } from './tree.js';

export interface MapJson {
  version: 1;
  repoId: string;
  /** Repo-relative filter path or chunk id, null for the whole repo. */
  filter: string | null;
  generatedAt: string;
  root: MapNode;
}

export interface StatusJson extends StatusReport {
  version: 1;
  generatedAt: string;
}

/** Copies only MapNode fields (never spreads) and cuts the tree `depth` levels below `node`. */
export function copyMapNode(node: MapNode, depth?: number): MapNode {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    path: node.path,
    lines: node.lines ? { start: node.lines.start, end: node.lines.end } : null,
    loc: node.loc,
    complexity: node.complexity,
    fanIn: node.fanIn,
    isLeaf: node.isLeaf,
    questionCount: node.questionCount,
    okQuestions: node.okQuestions,
    state: { color: node.state.color, R: node.state.R, dueAt: node.state.dueAt },
    children: depth === 0 ? [] : node.children.map((c) => copyMapNode(c, depth === undefined ? undefined : depth - 1)),
  };
}

export type MapJsonResult =
  | { status: 'ok'; json: MapJson }
  /** chunks.json has no root chunk. */
  | { status: 'no_root' }
  | { status: 'no_match'; filter: string };

export interface MapJsonOptions {
  /** Display title of the root; chunks.json titles it '.' (checkout-independent). */
  rootTitle: string;
  filter: string | null;
  generatedAt: Date;
}

/** The `--json` document for a loaded map, filtered to `filter`. Leaves `snapshot` untouched. */
export function mapJsonFrom(snapshot: MapSnapshot, opts: MapJsonOptions): MapJsonResult {
  if (!snapshot.root) return { status: 'no_root' };
  const full: MapNode = { ...snapshot.root, title: opts.rootTitle };
  const tree = opts.filter === null ? full : filterTree(full, opts.filter);
  if (!tree) return { status: 'no_match', filter: opts.filter! };
  return {
    status: 'ok',
    json: { version: 1, repoId: snapshot.repoId, filter: opts.filter, generatedAt: opts.generatedAt.toISOString(), root: copyMapNode(tree) },
  };
}

export function statusJsonFrom(report: StatusReport, generatedAt: Date): StatusJson {
  const { scanned, chunks, leaves, questions, due, colors } = report;
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    scanned,
    chunks,
    leaves,
    questions,
    due,
    colors: { grey: colors.grey, red: colors.red, yellow: colors.yellow, green: colors.green },
  };
}
