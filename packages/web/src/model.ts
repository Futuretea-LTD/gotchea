// Pure helpers over the `/api/map` document: lookup, breadcrumb, counters, URL hash,
// display formatting and the copyable commands. No DOM.
import type { ChunkColor, MapJson, MapNode } from 'gotchea-core';

export type { ChunkColor, MapJson, MapNode };

/** Display order, worst first (same as the CLI legend's colours, README "Colors"). */
export const COLORS: readonly ChunkColor[] = ['red', 'yellow', 'green', 'grey'];

/** Text that carries the state next to the colour, so nothing depends on colour alone. */
export const COLOR_INFO: Record<ChunkColor, { mark: string; label: string; meaning: string }> = {
  red: { mark: '!', label: 'red', meaning: 'never passed, must re-pass, or R < yellow threshold' },
  yellow: { mark: '~', label: 'yellow', meaning: 'fading: time for a review' },
  green: { mark: '✓', label: 'green', meaning: 'fresh in memory' },
  grey: { mark: '–', label: 'grey', meaning: 'no questions yet' },
};

export function findNode(root: MapNode, id: string): MapNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Nodes from `root` down to the node with `id` (inclusive); empty when it is not in the tree. */
export function pathTo(root: MapNode, id: string): MapNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const rest = pathTo(c, id);
    if (rest.length > 0) return [root, ...rest];
  }
  return [];
}

/**
 * The deepest node on the way to `id` that still exists: after a rescan removed the
 * selected chunk, the view falls back to its closest surviving ancestor.
 */
export function closestExisting(root: MapNode, id: string): MapNode {
  let best = root;
  const visit = (node: MapNode): void => {
    for (const c of node.children) {
      if (c.id === id || isAncestorId(c.id, id)) {
        best = c;
        visit(c);
        return;
      }
    }
  };
  visit(root);
  return best;
}

function isAncestorId(ancestor: string, id: string): boolean {
  if (ancestor === '.') return true;
  return id.startsWith(`${ancestor}/`) || id.startsWith(`${ancestor}#`) || (ancestor.includes('#') && id.startsWith(`${ancestor}.`));
}

/** Leaf count per colour below (and including) `node`, like the legend under `gotchea map`. */
export function colorCounts(node: MapNode): Record<ChunkColor, number> {
  const counts: Record<ChunkColor, number> = { red: 0, yellow: 0, green: 0, grey: 0 };
  const visit = (n: MapNode): void => {
    if (n.isLeaf) counts[n.state.color]++;
    for (const c of n.children) visit(c);
  };
  visit(node);
  return counts;
}

/** True when the repo has nothing to show: no chunks below the root, or no lines of code at all. */
export function isEmptyMap(root: MapNode): boolean {
  return root.children.length === 0 || root.loc === 0;
}

// ---- URL hash: `#/src/auth/session.ts` selects that node, `#/` is the root ----

export function hashFor(id: string): string {
  if (id === '.') return '#/';
  // Ids contain '#' (symbols); encode it so the hash stays one fragment.
  return `#/${encodeURI(id).replace(/#/g, '%23')}`;
}

export function idFromHash(hash: string): string {
  const raw = hash.replace(/^#\/?/, '');
  if (raw === '') return '.';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---- display ----

export function displayName(node: MapNode): string {
  return node.kind === 'module' && node.id !== '.' ? `${node.title}/` : node.title;
}

export function formatR(R: number | null): string {
  return R === null ? '–' : `${Math.round(R * 100)}%`;
}

export function formatDue(dueAt: string | null, now: Date): string {
  if (dueAt === null) return '–';
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return '–';
  const date = at.toISOString().slice(0, 10);
  return at.getTime() <= now.getTime() ? `${date} (due now)` : date;
}

/** POSIX-shell quoting for a chunk id (ids may contain '#', spaces or quotes). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Copyable commands for a node: quiz for every leaf, generate for a grey leaf. The web UI never quizzes. */
export function commandsFor(node: MapNode): { label: string; command: string }[] {
  if (!node.isLeaf) return [];
  const out = [{ label: 'Quiz', command: `gotchea quiz ${shellQuote(node.id)}` }];
  if (node.state.color === 'grey') out.push({ label: 'Generate questions', command: `gotchea generate --chunk ${shellQuote(node.id)}` });
  return out;
}
