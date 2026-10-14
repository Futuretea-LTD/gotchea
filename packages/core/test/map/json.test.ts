import { describe, expect, it } from 'vitest';
import { copyMapNode, mapJsonFrom, statusJsonFrom } from '../../src/map/json.js';
import type { MapNode } from '../../src/map/tree.js';

const leaf = (id: string, extra: Record<string, unknown> = {}): MapNode =>
  ({
    id,
    kind: 'file',
    title: id,
    path: id,
    lines: null,
    loc: 5,
    complexity: 1,
    fanIn: 0,
    isLeaf: true,
    questionCount: 3,
    okQuestions: 2,
    state: { color: 'red', R: 0, dueAt: null },
    children: [],
    ...extra,
  }) as MapNode;

const tree = (): MapNode => ({
  ...leaf('.'),
  kind: 'module',
  title: '.',
  path: null,
  isLeaf: false,
  questionCount: 0,
  okQuestions: 0,
  children: [{ ...leaf('src'), kind: 'module', path: null, isLeaf: false, children: [leaf('src/a.ts'), leaf('src/b.ts')] }],
});

const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('copyMapNode', () => {
  it('copies only MapNode fields, deeply, and cuts at depth', () => {
    // Extra keys a caller might have attached (e.g. answer data) never survive the copy.
    const dirty = { ...tree(), correctIndex: 1, explanation: 'x' } as MapNode;
    dirty.children[0]!.children[0] = leaf('src/a.ts', { options: ['a'], stem: 's' });
    const copy = copyMapNode(dirty);
    expect(JSON.stringify(copy)).not.toMatch(/correctIndex|explanation|options|stem/);
    expect(copy).toEqual(tree());
    expect(copy.children[0]).not.toBe(dirty.children[0]);
    expect(copyMapNode(tree(), 1).children[0]!.children).toEqual([]);
    expect(copyMapNode(tree(), 0).children).toEqual([]);
  });
});

describe('mapJsonFrom', () => {
  it('builds the --json document with the display title, leaving the snapshot untouched', () => {
    const snapshot = { repoId: 'r1', root: tree() };
    const r = mapJsonFrom(snapshot, { rootTitle: 'repo', filter: null, generatedAt: NOW });
    expect(r).toMatchObject({ status: 'ok', json: { version: 1, repoId: 'r1', filter: null, generatedAt: NOW.toISOString() } });
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(Object.keys(r.json)).toEqual(['version', 'repoId', 'filter', 'generatedAt', 'root']);
    expect(r.json.root.title).toBe('repo');
    expect(snapshot.root.title).toBe('.');
  });

  it('filters, keeping the renamed root as ancestor', () => {
    const r = mapJsonFrom({ repoId: 'r1', root: tree() }, { rootTitle: 'repo', filter: 'src/b.ts', generatedAt: NOW });
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.json.filter).toBe('src/b.ts');
    expect(r.json.root.title).toBe('repo');
    expect(r.json.root.children[0]!.children.map((c) => c.id)).toEqual(['src/b.ts']);
  });

  it('reports a missing root and a filter without matches', () => {
    expect(mapJsonFrom({ repoId: 'r1', root: null }, { rootTitle: 'x', filter: null, generatedAt: NOW })).toEqual({ status: 'no_root' });
    expect(mapJsonFrom({ repoId: 'r1', root: tree() }, { rootTitle: 'x', filter: 'nope', generatedAt: NOW })).toEqual({ status: 'no_match', filter: 'nope' });
  });
});

describe('statusJsonFrom', () => {
  it('adds version and generatedAt and copies only report fields', () => {
    const report = { scanned: true, chunks: 4, leaves: 2, questions: 4, due: 1, colors: { grey: 0, red: 2, yellow: 0, green: 0 }, extra: 1 };
    expect(statusJsonFrom(report, NOW)).toEqual({
      version: 1,
      generatedAt: NOW.toISOString(),
      scanned: true,
      chunks: 4,
      leaves: 2,
      questions: 4,
      due: 1,
      colors: { grey: 0, red: 2, yellow: 0, green: 0 },
    });
  });
});
