import type { ChunkColor, MapJson, MapNode } from 'gotchea-core';
import type { FetchLike } from '../src/api.js';

type NodeInput = Partial<Omit<MapNode, 'state' | 'children'>> & {
  id: string;
  color?: ChunkColor;
  R?: number | null;
  dueAt?: string | null;
  children?: MapNode[];
};

export function node(input: NodeInput): MapNode {
  const children = input.children ?? [];
  const isLeaf = input.isLeaf ?? children.length === 0;
  const kind = input.kind ?? (input.id === '.' || (!input.id.includes('.') && !input.id.includes('#')) ? 'module' : input.id.includes('#') ? 'symbol' : 'file');
  return {
    id: input.id,
    kind,
    title: input.title ?? input.id.split(/[/#]/).pop()!,
    path: input.path ?? (kind === 'module' ? null : input.id.split('#')[0]!),
    lines: input.lines ?? null,
    loc: input.loc ?? children.reduce((s, c) => s + c.loc, 0),
    complexity: input.complexity ?? 1,
    fanIn: input.fanIn ?? 0,
    isLeaf,
    questionCount: input.questionCount ?? (isLeaf ? 3 : 0),
    okQuestions: input.okQuestions ?? 0,
    state: { color: input.color ?? 'grey', R: input.R ?? null, dueAt: input.dueAt ?? null },
    children,
  };
}

/** repo/ (src/ (math.ts [clamp, mean], util.ts), empty.ts 0 LOC, README-ish leaf) */
export function sampleMap(): MapJson {
  const root = node({
    id: '.',
    title: 'repo',
    color: 'yellow',
    R: 0.6,
    children: [
      node({
        id: 'src',
        color: 'yellow',
        R: 0.6,
        children: [
          node({
            id: 'src/math.ts',
            color: 'yellow',
            R: 0.6,
            children: [
              node({ id: 'src/math.ts#clamp', loc: 12, color: 'green', R: 0.95, okQuestions: 6, questionCount: 3, dueAt: '2026-11-01T00:00:00.000Z' }),
              node({ id: 'src/math.ts#mean', loc: 18, color: 'red', R: 0, okQuestions: 4, questionCount: 3 }),
            ],
          }),
          node({ id: 'src/util.ts', loc: 20, color: 'grey' }),
          node({ id: 'src/empty.ts', loc: 0, color: 'grey' }),
        ],
      }),
      node({ id: 'app.py', loc: 10, color: 'grey' }),
    ],
  });
  return { version: 1, repoId: 'r1', filter: null, generatedAt: '2026-10-14T12:00:00.000Z', root };
}

export interface FakeServer {
  fetch: FetchLike;
  requests: { url: string; headers: Record<string, string> }[];
  /** What the next requests answer: a map (with an ETag), not scanned, or a network failure. */
  set(answer: MapJson | 'not_scanned' | 'offline'): void;
}

export function fakeServer(initial: MapJson | 'not_scanned' | 'offline'): FakeServer {
  let answer = initial;
  let version = 0;
  const requests: FakeServer['requests'] = [];
  return {
    requests,
    set(a) {
      answer = a;
      version++;
    },
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (answer === 'offline') throw new TypeError('fetch failed');
      if (answer === 'not_scanned') {
        return new Response(JSON.stringify({ error: 'not_scanned', message: 'Run `gotchea scan` first.' }), { status: 404 });
      }
      const etag = `"v${version}"`;
      if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(JSON.stringify(answer), { status: 200, headers: { ETag: etag, 'Content-Type': 'application/json' } });
    },
  };
}
