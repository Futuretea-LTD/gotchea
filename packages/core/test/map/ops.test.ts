import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsQuestionStore, type QuestionPrivate } from '../../src/internal.js';
import { getStatus, initConfig, isInitialized, loadMapTree, okQuestionCounts, runScan, type MapNode } from '../../src/index.js';
import { copyFixture, type FixtureRepo } from '../helpers/fixture-repo.js';

let fx: FixtureRepo;
beforeEach(async () => {
  fx = await copyFixture('ts-basic');
});
afterEach(() => fx.cleanup());

const q = (id: string, chunk: { id: string; contentHash: string }, status: QuestionPrivate['status']): QuestionPrivate => ({
  id,
  chunkId: chunk.id,
  chunkHash: chunk.contentHash,
  type: 'behavior',
  stem: 'SECRET-STEM',
  options: ['a', 'b', 'c', 'd'],
  correctIndex: 2,
  explanation: 'SECRET-EXPLANATION',
  refs: [],
  difficulty: 1,
  lang: 'en',
  generatedBy: 'test',
  status,
  flagged: false,
  chunkLines: 0,
  promptVersion: 'p1',
  verifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('isInitialized', () => {
  it('is false before init and true after', async () => {
    expect(await isInitialized(fx.root)).toBe(false);
    await initConfig(fx.root);
    expect(await isInitialized(fx.root)).toBe(true);
  });
});

describe('runScan / getStatus / loadMapTree', () => {
  it('reports an unscanned repo without throwing', async () => {
    await initConfig(fx.root);
    expect(await getStatus(fx.root, { env: fx.env })).toMatchObject({ scanned: false, chunks: 0, due: 0 });
    expect(await loadMapTree(fx.root, { env: fx.env })).toBeNull();
  });

  it('summarizes the diff in counts', async () => {
    await initConfig(fx.root);
    const first = await runScan(fx.root, { env: fx.env, useGit: false });
    expect(first.summary).toEqual({ added: first.result.chunks.length, changed: 0, moved: 0, removed: 0, total: first.result.chunks.length });
    const again = await runScan(fx.root, { env: fx.env, useGit: false });
    expect(again.summary).toEqual({ added: 0, changed: 0, moved: 0, removed: 0, total: first.summary.total });
  });

  it('counts only ok questions and never leaks answers', async () => {
    await initConfig(fx.root);
    const { result } = await runScan(fx.root, { env: fx.env, useGit: false });
    const leaves = result.chunks.filter((c) => c.isLeaf);
    const store = new FsQuestionStore(fx.root);
    await store.save(leaves[0]!.id, [q('a', leaves[0]!, 'ok'), q('b', leaves[0]!, 'ok'), q('c', leaves[0]!, 'stale')]);
    await store.save(leaves[1]!.id, [{ ...q('d', leaves[1]!, 'ok'), flagged: true }]);
    // generated against an older hash: not usable even though the scan has not staled it
    await store.save(leaves[2]!.id, [{ ...q('e', leaves[2]!, 'ok'), chunkHash: 'old-hash' }]);

    expect([...(await okQuestionCounts(fx.root))]).toEqual([
      [leaves[0]!.id, 2],
      [leaves[2]!.id, 1],
    ].sort(([a], [b]) => (a! < b! ? -1 : 1)));
    const counts = await okQuestionCounts(fx.root, result.chunks);
    expect([...counts]).toEqual([[leaves[0]!.id, 2]]);

    const status = await getStatus(fx.root, { env: fx.env, now: new Date('2026-10-14T00:00:00Z') });
    expect(status).toMatchObject({ scanned: true, chunks: result.chunks.length, leaves: leaves.length, questions: 2, due: 0 });
    expect(status.colors.grey + status.colors.red + status.colors.yellow + status.colors.green).toBe(leaves.length);
    expect(status.colors.red).toBe(1); // has questions, never passed

    const map = await loadMapTree(fx.root, { env: fx.env });
    expect(JSON.stringify(map)).not.toMatch(/SECRET|correctIndex|explanation/);
    expect(map!.root!.children.length).toBeGreaterThan(0);
    const nodes = new Map<string, MapNode>();
    const walk = (n: MapNode): void => {
      nodes.set(n.id, n);
      n.children.forEach(walk);
    };
    walk(map!.root!);
    expect(nodes.get(leaves[0]!.id)).toMatchObject({ okQuestions: 2, state: { color: 'red', R: 0 } });
    expect(nodes.get(leaves[1]!.id)).toMatchObject({ okQuestions: 0, state: { color: 'grey' } }); // flagged only
    expect(nodes.get(leaves[2]!.id)).toMatchObject({ okQuestions: 0, state: { color: 'grey' } }); // stale hash
  });
});
