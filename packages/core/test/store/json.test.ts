import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chunk, ChunksFile } from '../../src/model/chunk.js';
import { readJsonFile, writeFileAtomic } from '../../src/store/atomic-write.js';
import { canonicalJson, serializeChunksFile, stableStringify } from '../../src/store/json.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotchea-json-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('writeFileAtomic / readJsonFile', () => {
  it('creates parent dirs, writes, overwrites and leaves no tmp files', async () => {
    const p = join(dir, 'a', 'b', 'f.json');
    await writeFileAtomic(p, '{"x":1}');
    await writeFileAtomic(p, '{"x":2}');
    await Promise.all([1, 2, 3, 4, 5].map((n) => writeFileAtomic(p, `{"x":${n}}`)));
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['f.json']);
    expect(await readJsonFile<{ x: number }>(p)).toMatchObject({ x: expect.any(Number) });
  });

  it('removes the tmp file when the rename fails', async () => {
    const target = join(dir, 'target');
    await writeFileAtomic(join(target, 'inner'), 'x'); // target is now a non-empty directory
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('readJsonFile returns null for missing files and throws on bad JSON', async () => {
    expect(await readJsonFile(join(dir, 'missing.json'))).toBeNull();
    await writeFile(join(dir, 'bad.json'), '{');
    await expect(readJsonFile(join(dir, 'bad.json'))).rejects.toThrow(/Invalid JSON/);
  });
});

describe('stableStringify / canonicalJson', () => {
  it('sorts keys recursively, pretty with trailing newline, keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('keeps caller key order when sortKeys is false', () => {
    expect(canonicalJson({ b: 1, a: 2 }, { sortKeys: false })).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });

  it('sorts keys by code unit, not locale', () => {
    expect(Object.keys(JSON.parse(stableStringify({ b: 1, B: 2, a: 3, _: 4 })))).toEqual(['B', '_', 'a', 'b']);
  });
});

function chunk(id: string, extra: Partial<Chunk> = {}): Chunk {
  return {
    id,
    kind: 'symbol',
    parentId: 'src/a.ts',
    title: id,
    source: 'code',
    lang: 'typescript',
    ranges: [{ path: 'src/a.ts', start: 1, end: 10 }],
    contentHash: 'abcdef0123456789',
    metrics: { loc: 10, complexity: 2, fanIn: 1 },
    questionCount: 3,
    isLeaf: true,
    ...extra,
  };
}

function shuffleKeys<T extends object>(o: T): T {
  const entries = Object.entries(o).reverse();
  return Object.fromEntries(
    entries.map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? shuffleKeys(v as object) : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? shuffleKeys(x as object) : x)) : v]),
  ) as T;
}

describe('serializeChunksFile', () => {
  const chunks: Chunk[] = [
    chunk('src/a.ts#b', { aliases: ['src/old.ts#b'] }),
    chunk('src/a.ts', { kind: 'file', parentId: 'src', isLeaf: false, questionCount: 0 }),
    chunk('src', { kind: 'module', parentId: '.' }),
    chunk('.', { kind: 'module', parentId: null }),
    chunk('src/a.ts#B'),
    chunk('src/a.ts#~top'),
  ];
  const file: ChunksFile = { version: 1, normalization: 'n1', chunks };

  it('is byte-identical regardless of chunk order and key order', () => {
    const a = serializeChunksFile(file);
    const shuffled: ChunksFile = shuffleKeys({ ...file, chunks: [...chunks].reverse().map(shuffleKeys) });
    const rotated: ChunksFile = { ...file, chunks: [...chunks.slice(3), ...chunks.slice(0, 3)] };
    expect(serializeChunksFile(shuffled)).toBe(a);
    expect(serializeChunksFile(rotated)).toBe(a);
  });

  it('sorts by code unit and uses the fixed key order', () => {
    const parsed = JSON.parse(serializeChunksFile(file)) as ChunksFile;
    expect(Object.keys(parsed)).toEqual(['version', 'normalization', 'chunks']);
    expect(parsed.chunks.map((c) => c.id)).toEqual(['.', 'src', 'src/a.ts', 'src/a.ts#B', 'src/a.ts#b', 'src/a.ts#~top']);
    const withAliases = parsed.chunks.find((c) => c.id === 'src/a.ts#b')!;
    expect(Object.keys(withAliases)).toEqual([
      'id', 'kind', 'parentId', 'title', 'source', 'lang', 'isLeaf', 'ranges', 'contentHash', 'metrics', 'questionCount', 'aliases',
    ]);
    expect(Object.keys(withAliases.ranges[0]!)).toEqual(['path', 'start', 'end']);
    expect(Object.keys(withAliases.metrics)).toEqual(['loc', 'complexity', 'fanIn']);
  });

  it('omits undefined optional fields', () => {
    const { lang: _lang, ...noLang } = chunk('x');
    const out = serializeChunksFile({ version: 1, normalization: 'n1', chunks: [{ ...noLang, aliases: undefined } as unknown as Chunk] });
    expect(out).not.toContain('"lang"');
    expect(out).not.toContain('"aliases"');
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('does not mutate the input', () => {
    const copy = structuredClone(file);
    serializeChunksFile(file);
    expect(file).toEqual(copy);
  });

  it('writes the same bytes through writeFileAtomic', async () => {
    const p = join(dir, 'chunks.json');
    await writeFileAtomic(p, serializeChunksFile(file));
    expect(await readFile(p, 'utf8')).toBe(serializeChunksFile(file));
  });
});
