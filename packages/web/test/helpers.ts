import type { ChunkColor, MapJson, MapNode, StatusJson } from 'gotchea-core';
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

/** Repo-wide counters matching nothing in particular: 3 of 8 leaves green (37.5%), 2 due. */
export function sampleStatus(): StatusJson {
  return {
    version: 1,
    generatedAt: '2026-10-14T12:00:00.000Z',
    scanned: true,
    chunks: 12,
    leaves: 8,
    questions: 24,
    due: 2,
    colors: { grey: 2, red: 2, yellow: 1, green: 3 },
  };
}

export interface FakeServer {
  fetch: FetchLike;
  requests: { url: string; headers: Record<string, string> }[];
  /** What the next requests answer: a map (with an ETag), not scanned, or a network failure. */
  set(answer: MapJson | 'not_scanned' | 'offline'): void;
  /** What `/api/status` answers next: a document, or a 500. */
  setStatus(answer: StatusJson | 'error'): void;
}

export function fakeServer(initial: MapJson | 'not_scanned' | 'offline', initialStatus: StatusJson | 'error' = sampleStatus()): FakeServer {
  let answer = initial;
  let statusAnswer = initialStatus;
  let version = 0;
  const requests: FakeServer['requests'] = [];
  return {
    requests,
    set(a) {
      answer = a;
      version++;
    },
    setStatus(s) {
      statusAnswer = s;
    },
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers });
      if (answer === 'offline') throw new TypeError('fetch failed');
      if (url === '/api/status') {
        if (statusAnswer === 'error') return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
        return new Response(JSON.stringify(statusAnswer), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (answer === 'not_scanned') {
        return new Response(JSON.stringify({ error: 'not_scanned', message: 'Run `gotchea scan` first.' }), { status: 404 });
      }
      const etag = `"v${version}"`;
      if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(JSON.stringify(answer), { status: 200, headers: { ETag: etag, 'Content-Type': 'application/json' } });
    },
  };
}
