import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chunk, ChunksFile } from '../../src/model/chunk.js';
import { questionFileName } from '../../src/model/ids.js';
import type { ProgressFile } from '../../src/model/progress.js';
import type { QuestionPrivate } from '../../src/model/question.js';
import { FsChunkStore, InMemoryChunkStore } from '../../src/store/chunk-store.js';
import { serializeChunksFile } from '../../src/store/json.js';
import { userPaths } from '../../src/store/paths.js';
import { FsProgressStore, InMemoryProgressStore } from '../../src/store/progress-store.js';
import { countUsable, insertQuestions, isStale, markStale } from '../../src/store/question-pool.js';
import { FsQuestionStore, InMemoryQuestionStore } from '../../src/store/question-store.js';
import { FsSnapshotStore, InMemorySnapshotStore } from '../../src/store/snapshot-store.js';
import type { ChunkStore, ProgressStore, QuestionStore, SnapshotStore } from '../../src/store/types.js';

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotchea-store-'));
  home = await mkdtemp(join(tmpdir(), 'gotchea-home-'));
  env = { GOTCHEA_HOME: home };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
});

const REPO = '0123456789abcdef';

function chunk(id: string): Chunk {
  return {
    id,
    kind: 'file',
    parentId: '.',
    title: id,
    source: 'code',
    ranges: [{ path: id, start: 1, end: 3 }],
    contentHash: 'ffffffffffffffff',
    metrics: { loc: 3, complexity: 1, fanIn: 0 },
    questionCount: 3,
    isLeaf: true,
  };
}

function q(id: string, chunkId: string, stem = `stem ${id}`): QuestionPrivate {
  return {
    id,
    chunkId,
    chunkHash: 'ffffffffffffffff',
    type: 'behavior',
    stem,
    options: ['a', 'b', 'c', 'd'],
    correctIndex: 1,
    explanation: 'because',
    refs: [{ start: 1, end: 2 }],
    difficulty: 2,
    lang: 'en',
    generatedBy: 'host:test',
    status: 'ok',
    flagged: false,
    chunkLines: 0,
    promptVersion: 'p1',
    verifiedBy: null,
    createdAt: '2026-10-14T00:00:00.000Z',
  };
}

const chunkStores: [string, () => ChunkStore][] = [
  ['FsChunkStore', () => new FsChunkStore(root)],
  ['InMemoryChunkStore', () => new InMemoryChunkStore()],
];

describe.each(chunkStores)('%s', (_name, make) => {
  it('load returns null when nothing was saved', async () => {
    expect(await make().load()).toBeNull();
  });

  it('round-trips, sorted by id, without aliasing', async () => {
    const store = make();
    const file: ChunksFile = { version: 1, normalization: 'n1', chunks: [chunk('b.ts'), chunk('a.ts')] };
    await store.save(file);
    file.chunks[0]!.title = 'mutated';
    const loaded = await store.load();
    expect(loaded?.chunks.map((c) => c.id)).toEqual(['a.ts', 'b.ts']);
    expect(loaded?.chunks[1]?.title).toBe('b.ts');
    loaded!.chunks[0]!.title = 'mutated again';
    expect((await store.load())?.chunks[0]?.title).toBe('a.ts');
  });
});

describe('FsChunkStore specifics', () => {
  it('writes serializeChunksFile bytes to .gotchea/chunks.json', async () => {
    const file: ChunksFile = { version: 1, normalization: 'n1', chunks: [chunk('b.ts'), chunk('a.ts')] };
    await new FsChunkStore(root).save(file);
    expect(await readFile(join(root, '.gotchea', 'chunks.json'), 'utf8')).toBe(serializeChunksFile(file));
    expect(await readdir(join(root, '.gotchea'))).toEqual(['chunks.json']);
  });

  it('rejects an unsupported version', async () => {
    await mkdir(join(root, '.gotchea'), { recursive: true });
    await writeFile(join(root, '.gotchea', 'chunks.json'), JSON.stringify({ version: 2, normalization: 'n1', chunks: [] }));
    await expect(new FsChunkStore(root).load()).rejects.toThrow(/version 2/);
  });
});

const questionStores: [string, () => QuestionStore][] = [
  ['FsQuestionStore', () => new FsQuestionStore(root)],
  ['InMemoryQuestionStore', () => new InMemoryQuestionStore()],
];

describe.each(questionStores)('%s', (_name, make) => {
  it('list returns [] for unknown chunks', async () => {
    const s = make();
    expect(await s.list('nope')).toEqual([]);
    expect(await s.chunkIds()).toEqual([]);
  });

  it('round-trips questions sorted by id', async () => {
    const s = make();
    await s.save('src/a.ts#f', [q('q2', 'src/a.ts#f'), q('q1', 'src/a.ts#f')]);
    expect((await s.list('src/a.ts#f')).map((x) => x.id)).toEqual(['q1', 'q2']);
    expect(await s.list('src/a.ts#f')).toEqual([q('q1', 'src/a.ts#f'), q('q2', 'src/a.ts#f')]);
  });

  it('saving [] deletes the pool; remove is idempotent', async () => {
    const s = make();
    await s.save('a', [q('q1', 'a')]);
    await s.save('b', [q('q1', 'b')]);
    expect(await s.chunkIds()).toEqual(['a', 'b']);
    await s.save('a', []);
    expect(await s.list('a')).toEqual([]);
    await s.remove('b');
    await s.remove('b');
    expect(await s.chunkIds()).toEqual([]);
  });

  it('move rewrites chunkId and removes the source', async () => {
    const s = make();
    await s.save('old', [q('q1', 'old'), q('q2', 'old')]);
    await s.move('old', 'new');
    expect(await s.list('old')).toEqual([]);
    const moved = await s.list('new');
    expect(moved.map((x) => [x.id, x.chunkId])).toEqual([
      ['q1', 'new'],
      ['q2', 'new'],
    ]);
    expect(await s.chunkIds()).toEqual(['new']);
  });

  it('move merges into an existing pool, destination wins on id clashes', async () => {
    const s = make();
    await s.save('from', [q('q1', 'from', 'source q1'), q('q3', 'from')]);
    await s.save('to', [q('q1', 'to', 'dest q1'), q('q2', 'to')]);
    await s.move('from', 'to');
    const merged = await s.list('to');
    expect(merged.map((x) => x.id)).toEqual(['q1', 'q2', 'q3']);
    expect(merged.every((x) => x.chunkId === 'to')).toBe(true);
    expect(merged[0]!.stem).toBe('dest q1');
    expect(await s.chunkIds()).toEqual(['to']);
  });

  it('move of a missing pool is a no-op', async () => {
    const s = make();
    await s.save('to', [q('q1', 'to')]);
    await s.move('missing', 'to');
    expect((await s.list('to')).length).toBe(1);
  });

  it('does not alias saved or listed arrays', async () => {
    const s = make();
    const qs = [q('q1', 'a')];
    await s.save('a', qs);
    qs[0]!.stem = 'mutated';
    const listed = await s.list('a');
    expect(listed[0]!.stem).toBe('stem q1');
    listed[0]!.stem = 'mutated';
    expect((await s.list('a'))[0]!.stem).toBe('stem q1');
  });
});

describe('FsQuestionStore specifics', () => {
  it('stores one QuestionsFile per chunk named by questionFileName', async () => {
    const s = new FsQuestionStore(root);
    const id = 'src/auth/session.ts#SessionStore.refresh';
    await s.save(id, [q('q2', id), q('q1', id)]);
    const name = questionFileName(id);
    expect(name).toMatch(/^src_auth_session_ts_SessionStore_refresh--[0-9a-f]{8}\.json$/);
    expect(await readdir(join(root, '.gotchea', 'questions'))).toEqual([name]);
    const raw = await readFile(join(root, '.gotchea', 'questions', name), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw) as { version: number; chunkId: string; questions: QuestionPrivate[] };
    expect(parsed.version).toBe(2);
    expect(parsed.chunkId).toBe(id);
    expect(parsed.questions.map((x) => x.id)).toEqual(['q1', 'q2']);
    // stable: rewriting the same content yields identical bytes
    await s.save(id, [q('q1', id), q('q2', id)]);
    expect(await readFile(join(root, '.gotchea', 'questions', name), 'utf8')).toBe(raw);
  });

  it('question file names are portable and never leave the questions directory', () => {
    for (const id of ['src/a.ts#x:y', 'src\\a.ts#b', '../../etc/passwd', 'src/ü.ts#Ünïcode', 'a.ts#get *?"<>|']) {
      expect(questionFileName(id)).toMatch(/^[A-Za-z0-9_-]+--[0-9a-f]{8}\.json$/);
    }
    expect(questionFileName('src/a.ts#x:y')).not.toBe(questionFileName('src/a.ts#x_y'));
  });

  it('chunkIds skips unparseable question files (e.g. merge conflicts)', async () => {
    const s = new FsQuestionStore(root);
    await s.save('a.ts', [q('q', 'a.ts')]);
    await writeFile(join(root, '.gotchea', 'questions', 'broken--00000000.json'), '<<<<<<< HEAD\n{');
    expect(await s.chunkIds()).toEqual(['a.ts']);
  });

  it('chunkIds reads the chunkId field of each file', async () => {
    const s = new FsQuestionStore(root);
    await s.save('z/y.ts', [q('q', 'z/y.ts')]);
    await s.save('a.ts#~top', [q('q', 'a.ts#~top')]);
    await writeFile(join(root, '.gotchea', 'questions', 'README.txt'), 'not json');
    expect(await s.chunkIds()).toEqual(['a.ts#~top', 'z/y.ts']);
  });
});

describe('question pools v2', () => {
  it('upgrades v1 files on read: flagged status becomes ok + flagged, refs are dropped', async () => {
    const s = new FsQuestionStore(root);
    const v1 = (id: string, status: string) => {
      const { flagged: _f, chunkLines: _c, promptVersion: _p, verifiedBy: _v, ...rest } = q(id, 'a.ts');
      return { ...rest, refs: [{ path: 'a.ts', start: 1, end: 2 }], status };
    };
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.pathFor('a.ts'), JSON.stringify({ version: 1, chunkId: 'a.ts', questions: [v1('q1', 'flagged'), v1('q2', 'stale')] }));
    const listed = await s.list('a.ts');
    expect(listed.map((x) => [x.id, x.status, x.flagged, x.refs, x.chunkLines, x.promptVersion, x.verifiedBy])).toEqual([
      ['q1', 'ok', true, [], 0, 'p0', null],
      ['q2', 'stale', false, [], 0, 'p0', null],
    ]);
  });

  it('returns no questions when the file belongs to another chunk id', async () => {
    const s = new FsQuestionStore(root);
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.pathFor('a.ts'), JSON.stringify({ version: 2, chunkId: 'other.ts', questions: [q('q1', 'other.ts')] }));
    expect(await s.list('a.ts')).toEqual([]);
  });

  it('a corrupt pool throws without quoting the file (it may hold answer keys)', async () => {
    const s = new FsQuestionStore(root);
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.pathFor('a.ts'), '<<<<<<< HEAD\n{"explanation": "SECRET-EXPL"}');
    const err = await s.list('a.ts').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Invalid JSON in ${s.pathFor('a.ts')}`);
  });

  it.each(questionStores)('%s: concurrent inserts on one chunk keep both batches', async (_name, make) => {
    const s = make();
    const [a, b] = await Promise.all([insertQuestions(s, 'a.ts', [q('q1', 'a.ts')]), insertQuestions(s, 'a.ts', [q('q2', 'a.ts'), q('q1', 'a.ts')])]);
    expect(a.inserted.map((x) => x.id)).toEqual(['q1']);
    expect(b).toMatchObject({ duplicateIds: ['q1'] });
    expect((await s.list('a.ts')).map((x) => x.id)).toEqual(['q1', 'q2']);
    expect(await countUsable(s, 'a.ts', 'ffffffffffffffff')).toBe(2);
    expect(await countUsable(s, 'a.ts', 'new-hash')).toBe(0);
  });

  it('detects staleness by chunkHash', () => {
    const pool = [q('q1', 'a.ts'), { ...q('q2', 'a.ts'), chunkHash: 'new' }];
    expect(pool.map((x) => isStale(x, 'new'))).toEqual([true, false]);
    const r = markStale(pool, 'new');
    expect(r.staled).toBe(1);
    expect(r.pool.map((x) => x.status)).toEqual(['stale', 'ok']);
  });
});

function progressFile(repoId: string): ProgressFile {
  return {
    version: 1,
    repoId,
    chunks: {
      'b.ts': { stability: 3, lastReviewedAt: '2026-10-01T00:00:00Z', lastPassedHash: 'h', lastSeenHash: 'h', mustRepass: false, history: [] },
      'a.ts': { stability: null, lastReviewedAt: null, lastPassedHash: null, lastSeenHash: 'h2', mustRepass: true, history: [] },
    },
  };
}

const progressStores: [string, () => ProgressStore][] = [
  ['FsProgressStore', () => new FsProgressStore(REPO, env)],
  ['InMemoryProgressStore', () => new InMemoryProgressStore(REPO)],
];

describe.each(progressStores)('%s', (_name, make) => {
  it('load yields an empty file for the repo when missing', async () => {
    expect(await make().load()).toEqual({ version: 1, repoId: REPO, chunks: {} });
  });

  it('round-trips with sorted chunk keys', async () => {
    const s = make();
    const file = progressFile(REPO);
    await s.save(file);
    file.chunks['a.ts']!.mustRepass = false;
    const loaded = await s.load();
    expect(Object.keys(loaded.chunks)).toEqual(['a.ts', 'b.ts']);
    expect(loaded).toEqual(progressFile(REPO));
  });
});

describe('FsProgressStore specifics', () => {
  it('rejects repoIds that could escape GOTCHEA_HOME/repos/', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '/abs']) expect(() => userPaths(bad, env), bad).toThrow('Invalid repoId');
    expect(() => new FsProgressStore('../../tmp', env)).toThrow('Invalid repoId');
  });

  it('writes under GOTCHEA_HOME/repos/<repoId>/progress.json', async () => {
    await new FsProgressStore(REPO, env).save(progressFile(REPO));
    const path = join(home, 'repos', REPO, 'progress.json');
    expect(userPaths(REPO, env).progress).toBe(path);
    const raw = await readFile(path, 'utf8');
    expect(raw.indexOf('"a.ts"')).toBeLessThan(raw.indexOf('"b.ts"'));
    expect(raw.endsWith('}\n')).toBe(true);
  });
});

const snapshotStores: [string, () => SnapshotStore][] = [
  ['FsSnapshotStore', () => new FsSnapshotStore(REPO, env)],
  ['InMemorySnapshotStore', () => new InMemorySnapshotStore()],
];

describe.each(snapshotStores)('%s', (_name, make) => {
  it('get returns null when missing, put/get round-trips', async () => {
    const s = make();
    expect(await s.get('deadbeef')).toBeNull();
    await s.put('deadbeef', ['1a2b3c4d', '00000000']);
    expect(await s.get('deadbeef')).toEqual(['1a2b3c4d', '00000000']);
  });

  it('put does not overwrite an existing snapshot', async () => {
    const s = make();
    await s.put('0123456789abcdef', ['first']);
    await s.put('0123456789abcdef', ['second']);
    expect(await s.get('0123456789abcdef')).toEqual(['first']);
  });

  it.each(['../evil', 'DEADBEEF', 'abc', 'deadbeef/..', '', 'g0000000', 'a'.repeat(65)])('rejects bad hash %j', async (bad) => {
    const s = make();
    await expect(s.get(bad)).rejects.toThrow(/Invalid snapshot hash/);
    await expect(s.put(bad, [])).rejects.toThrow(/Invalid snapshot hash/);
  });
});

describe('FsSnapshotStore specifics', () => {
  it('stores a JSON array at snapshots/<hash>.json', async () => {
    await new FsSnapshotStore(REPO, env).put('deadbeef', ['x', 'y']);
    const raw = await readFile(join(home, 'repos', REPO, 'snapshots', 'deadbeef.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(['x', 'y']);
  });
});
