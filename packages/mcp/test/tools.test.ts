import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsChunkStore } from 'gotchea-core';
import {
  GetChunkForFileOutputSchema,
  GetMapOutputSchema,
  GetStatusOutputSchema,
  ScanOutputSchema,
} from '../src/schemas.js';
import { EXPLANATION, SOURCES, connect, createFixture, text, type Fixture } from './helpers.js';

let fx: Fixture;
let conn: Awaited<ReturnType<typeof connect>>;
const call = (name: string, args: Record<string, unknown> = {}) => conn.client.callTool({ name, arguments: args });

beforeAll(async () => {
  fx = await createFixture();
  conn = await connect(fx.root, fx.env);
});

afterAll(async () => {
  await conn.close();
  await fx.cleanup();
});

describe('fixture', () => {
  it('has the answer key on disk', async () => {
    const dir = join(fx.root, '.gotchea', 'questions');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const raw = await readFile(join(dir, files[0]!), 'utf8');
    expect(raw).toContain('correctIndex');
    expect(raw).toContain(EXPLANATION);
  });
});

describe('tools/list', () => {
  it('returns the four tools, each with an input schema', async () => {
    const { tools } = await conn.client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const names = tools.map((t) => t.name);
    for (const n of ['scan', 'get_map', 'get_chunk_for_file', 'get_status']) expect(names).toContain(n);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description).toBeTruthy();
    }
    const chunk = tools.find((t) => t.name === 'get_chunk_for_file')!;
    expect(chunk.inputSchema.required).toContain('path');
    expect(Object.keys(chunk.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['path', 'line']));
  });
});

describe('scan', () => {
  it('returns added/changed/moved/removed counts (unchanged repo: nothing new)', async () => {
    const res = await call('scan');
    expect(res.isError).toBeFalsy();
    const out = ScanOutputSchema.parse(res.structuredContent);
    expect(out.summary).not.toBeNull();
    const s = out.summary!;
    expect(s).toEqual({ added: 0, changed: 0, moved: 0, removed: 0, total: expect.any(Number) });
    expect(s.total).toBeGreaterThan(0);
    expect(text(res)).toMatch(/0 added, 0 changed, 0 moved, 0 removed/);
  });

  it('reports a changed file, then picks it up in the index', async () => {
    const repo = await createFixture();
    const c = await connect(repo.root, repo.env);
    try {
      await writeFile(join(repo.root, 'src/util/strings.ts'), SOURCES['src/util/strings.ts']!.replace('toUpperCase', 'toLowerCase'));
      await writeFile(join(repo.root, 'src/extra.ts'), 'export const extra = 1;\n');
      const res = await c.client.callTool({ name: 'scan', arguments: {} });
      const s = ScanOutputSchema.parse(res.structuredContent).summary!;
      expect(s.changed).toBeGreaterThan(0);
      expect(s.added).toBeGreaterThan(0);
      const hit = await c.client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/extra.ts' } });
      expect(GetChunkForFileOutputSchema.parse(hit.structuredContent).chunks.length).toBeGreaterThan(0);
    } finally {
      await c.close();
      await repo.cleanup();
    }
  });
});

describe('get_map', () => {
  it('validates against the output schema and renders a one-line summary first', async () => {
    const res = await call('get_map');
    expect(res.isError).toBeFalsy();
    const out = GetMapOutputSchema.parse(res.structuredContent);
    expect(out.root).not.toBeNull();

    const t = text(res);
    const lines = t.split('\n');
    expect(lines[0]).toMatch(/^\d+ chunk · \d+ soru · sonraki adım: .+$/);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).not.toMatch(/[⬜🟥🟨🟩]/u);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes
    expect(t).not.toMatch(/\x1b\[/);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ *[⬜🟥🟨🟩] .+ · \d+ LOC/u);
    expect(t).toMatch(/· 1 soru/);
    expect(t).toContain('math.ts');
  });

  it('structured question counts match the seed', async () => {
    const out = GetMapOutputSchema.parse((await call('get_map')).structuredContent);
    const flat: { id: string; okQuestions: number; isLeaf: boolean }[] = [];
    const walk = (n: { id: string; okQuestions: number; isLeaf: boolean; children: unknown[] }) => {
      flat.push(n);
      for (const c of n.children) walk(c as typeof n);
    };
    walk(out.root!);
    expect(fx.seededChunkId).toBe('src/math.ts');
    expect(flat.find((n) => n.id === fx.seededChunkId)?.okQuestions).toBe(1);
    expect(flat.filter((n) => n.isLeaf).reduce((a, n) => a + n.okQuestions, 0)).toBe(1);
  });

  it('respects the path arg', async () => {
    const res = await call('get_map', { path: 'src/util' });
    const out = GetMapOutputSchema.parse(res.structuredContent);
    expect(out.filter).toBe('src/util');
    const t = text(res);
    expect(t).toContain('strings.ts');
    expect(t).not.toContain('math.ts');
    expect(t).not.toContain('app.py');
  });

  it('respects the depth arg', async () => {
    const full = text(await call('get_map')).split('\n').length;
    const d0 = await call('get_map', { depth: 0 });
    expect(GetMapOutputSchema.parse(d0.structuredContent).root!.children).toEqual([]);
    expect(text(d0).split('\n')).toHaveLength(2); // summary + root
    const d1 = await call('get_map', { depth: 1 });
    const root = GetMapOutputSchema.parse(d1.structuredContent).root!;
    expect(root.children.length).toBeGreaterThan(0);
    for (const c of root.children) expect(c.children).toEqual([]);
    expect(text(d1).split('\n').length).toBeLessThan(full);
    // the summary line always describes the whole repo, regardless of depth
    expect(text(d0).split('\n')[0]).toBe(text(await call('get_map')).split('\n')[0]);
  });

  it('reports an unmatched path without failing', async () => {
    const res = await call('get_map', { path: 'does/not/exist' });
    expect(res.isError).toBeFalsy();
    expect(GetMapOutputSchema.parse(res.structuredContent).root).toBeNull();
  });
});

describe('get_chunk_for_file', () => {
  it('resolves a path to its file chunk followed by its leaves', async () => {
    const res = await call('get_chunk_for_file', { path: 'src/big.ts' });
    const { chunks } = GetChunkForFileOutputSchema.parse(res.structuredContent);
    expect(chunks[0]!.kind).toBe('file');
    expect(chunks[0]!.id).toBe('src/big.ts');
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.slice(1).every((c) => c.isLeaf && c.kind === 'symbol')).toBe(true);
    expect(text(res)).toContain('src/big.ts');
    // A small file is its own leaf.
    const small = GetChunkForFileOutputSchema.parse((await call('get_chunk_for_file', { path: 'src/math.ts' })).structuredContent);
    expect(small.chunks.map((c) => c.id)).toEqual(['src/math.ts']);
  });

  it('resolves path+line to the innermost chunk covering that line', async () => {
    const stored = (await new FsChunkStore(fx.root).load())!.chunks;
    const idAt = async (line: number) => {
      const res = await call('get_chunk_for_file', { path: 'src/big.ts', line });
      const { chunks } = GetChunkForFileOutputSchema.parse(res.structuredContent);
      expect(chunks).toHaveLength(1);
      const hit = chunks[0]!;
      const r = hit.ranges.find((x) => x.path === 'src/big.ts')!;
      expect(r.start).toBeLessThanOrEqual(line);
      expect(r.end).toBeGreaterThanOrEqual(line);
      expect(hit.isLeaf).toBe(true);
      expect(stored.some((c) => c.id === hit.id)).toBe(true);
      return hit.id;
    };
    const [alpha, beta, gamma] = [await idAt(2), await idAt(115), await idAt(225)];
    expect(new Set([alpha, beta, gamma]).size).toBe(3);
    expect(alpha).toContain('alpha');
    expect(beta).toContain('beta');
    expect(gamma).toContain('gamma');
    // Small file: the file chunk itself.
    const small = await call('get_chunk_for_file', { path: 'src/math.ts', line: 8 });
    expect(GetChunkForFileOutputSchema.parse(small.structuredContent).chunks[0]!.id).toBe('src/math.ts');
  });

  it('accepts absolute paths inside the root', async () => {
    const res = await call('get_chunk_for_file', { path: join(fx.root, 'src/math.ts'), line: 2 });
    expect(GetChunkForFileOutputSchema.parse(res.structuredContent).chunks).toHaveLength(1);
  });

  it('answers an unknown file with an empty, non-error result', async () => {
    const res = await call('get_chunk_for_file', { path: 'nope.ts' });
    expect(res.isError).toBeFalsy();
    expect(GetChunkForFileOutputSchema.parse(res.structuredContent).chunks).toEqual([]);
  });

  it('is served from the startup index, not from disk', async () => {
    const repo = await createFixture();
    const c = await connect(repo.root, repo.env);
    try {
      const before = await c.client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/math.ts', line: 2 } });
      const expected = GetChunkForFileOutputSchema.parse(before.structuredContent);
      expect(expected.chunks).toHaveLength(1);

      // Source deleted, another one rewritten: the index must not notice.
      await rm(join(repo.root, 'src/math.ts'));
      await writeFile(join(repo.root, 'src/util/strings.ts'), '// emptied\n');
      const after = await c.client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/math.ts', line: 2 } });
      expect(after.structuredContent).toEqual(before.structuredContent);
      const str = await c.client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/util/strings.ts', line: 2 } });
      expect(GetChunkForFileOutputSchema.parse(str.structuredContent).chunks).toHaveLength(1);

      // Even the persisted index files are not consulted per call.
      await rm(join(repo.root, '.gotchea', 'chunks.json'));
      const again = await c.client.callTool({ name: 'get_chunk_for_file', arguments: { path: 'src/big.ts', line: 2 } });
      expect(GetChunkForFileOutputSchema.parse(again.structuredContent).chunks[0]!.id).toContain('alpha');
    } finally {
      await c.close();
      await repo.cleanup();
    }
  });
});

describe('get_status', () => {
  it('returns tracked, questions, due and the colour distribution', async () => {
    const res = await call('get_status');
    expect(res.isError).toBeFalsy();
    const s = GetStatusOutputSchema.parse(res.structuredContent);
    const stored = (await new FsChunkStore(fx.root).load())!.chunks;
    expect(s.scanned).toBe(true);
    expect(s.chunks).toBe(stored.length);
    expect(s.leaves).toBe(stored.filter((c) => c.isLeaf).length);
    expect(s.questions).toBe(1);
    expect(s.due).toBeGreaterThanOrEqual(0);
    const { grey, red, yellow, green } = s.colors;
    expect(grey + red + yellow + green).toBe(s.leaves);
    const t = text(res);
    expect(t).toContain(`${s.chunks} chunks`);
    expect(t).toContain('1 questions');
    expect(t).toMatch(/⬜ \d+ 🟥 \d+ 🟨 \d+ 🟩 \d+/);
  });
});
