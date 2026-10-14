// Id stability, hash invariants and chunks.json determinism on the fixture repos.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Chunk } from '../../src/model/chunk.js';
import { scanRepo } from '../../src/scan/scan.js';
import { repoPaths } from '../../src/store/paths.js';
import { copyFixture, type FixtureName, type FixtureRepo } from '../helpers/fixture-repo.js';

const repos: FixtureRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function fixture(name: FixtureName): Promise<FixtureRepo> {
  const f = await copyFixture(name);
  repos.push(f);
  return f;
}

const scan = (f: FixtureRepo) => scanRepo({ root: f.root, repoId: 'stability', useGit: false, env: f.env });
const chunksJson = (f: FixtureRepo) => readFile(repoPaths(f.root).chunks, 'utf8');
const hashes = (chunks: readonly Chunk[]) => new Map(chunks.map((c) => [c.id, c.contentHash]));

const STRINGS = 'src/util/strings.ts';
const ENGINE = 'src/services/report-engine.ts';
const TEXT = 'app/util/text.py';

describe('determinism of chunks.json', () => {
  it.each(['ts-basic', 'py-basic'] as const)('%s: a re-scan writes byte-identical chunks.json and reports everything unchanged', async (name) => {
    const f = await fixture(name);
    const first = await scan(f);
    const bytes = await chunksJson(f);
    const second = await scan(f);
    expect(await chunksJson(f)).toBe(bytes);
    expect(second.diff.unchanged).toHaveLength(first.chunks.length);
    expect([...second.diff.added, ...second.diff.removed, ...second.diff.changed, ...second.diff.moved]).toEqual([]);
    expect(second.chunks.map((c) => c.id)).toEqual(first.chunks.map((c) => c.id));
  });

  it.each(['ts-basic', 'py-basic'] as const)('%s: two checkouts in different directories produce identical chunks.json', async (name) => {
    // chunks.json is committed and shared: it must not depend on where the repo is checked out.
    const a = await fixture(name);
    const b = await fixture(name);
    await scan(a);
    await scan(b);
    expect(await chunksJson(b)).toBe(await chunksJson(a));
  });

  it('chunks.json is sorted by id with a stable key order', async () => {
    const f = await fixture('ts-basic');
    await scan(f);
    const file = JSON.parse(await chunksJson(f)) as { version: number; normalization: string; chunks: Chunk[] };
    expect(Object.keys(file)).toEqual(['version', 'normalization', 'chunks']);
    const ids = file.chunks.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    const keyOrders = new Set(file.chunks.map((c) => Object.keys(c).filter((k) => k !== 'lang' && k !== 'aliases').join(',')));
    expect(keyOrders.size).toBe(1);
  });
});

describe('id stability', () => {
  it('ids do not change when unrelated code is inserted above a symbol (ts)', async () => {
    const f = await fixture('ts-basic');
    const before = (await scan(f)).chunks;
    // A 20-line function above the interfaces and the class shifts every line below it.
    const inserted = `export function preamble(input: number): number {\n${Array.from({ length: 18 }, (_, i) => `  input = input * 3 + ${i};`).join('\n')}\n  return input;\n}\n\n`;
    await f.edit(ENGINE, 'export interface ReportRow {', `${inserted}export interface ReportRow {`);
    // And a long helper at the top of strings.ts (long enough not to join a group).
    await f.edit(STRINGS, 'export function slugify(', `${inserted.replace('preamble', 'headline')}export function slugify(`);

    const r = await scan(f);
    const after = hashes(r.chunks);
    for (const c of before) {
      expect(after.has(c.id), `${c.id} still exists`).toBe(true);
      // Leaves keep their hash too: the hash depends on content, not on line numbers.
      if (c.isLeaf) expect(after.get(c.id), `${c.id} hash`).toBe(c.contentHash);
    }
    expect(r.diff.added).toEqual([`${ENGINE}#preamble`, `${STRINGS}#headline`]);
    expect(r.diff.removed).toEqual([]);
    // Only containers (files, split class, modules) changed hash.
    expect(r.diff.changed.map((c) => c.id)).toEqual(['.', 'src', 'src/services', ENGINE, 'src/util', STRINGS]);
    // Line ranges did move.
    const method = r.chunks.find((c) => c.id === `${ENGINE}#ReportEngine.addRow`)!;
    expect(method.ranges[0]!.start).toBe(before.find((c) => c.id === method.id)!.ranges[0]!.start + 22);
  });

  it('ids do not change when unrelated code is inserted above a symbol (py)', async () => {
    const f = await fixture('py-basic');
    const before = (await scan(f)).chunks;
    const inserted = `def banner(width):\n${Array.from({ length: 16 }, (_, i) => `    width = width * 2 + ${i}`).join('\n')}\n    return width\n\n\n`;
    // Above `_SLUG_RE` (the first group's anchor): the long function does not join or split the group.
    await f.edit(TEXT, '_SLUG_RE = re.compile', `${inserted}_SLUG_RE = re.compile`);
    const r = await scan(f);
    const after = hashes(r.chunks);
    for (const c of before) {
      expect(after.has(c.id), `${c.id} still exists`).toBe(true);
      if (c.isLeaf) expect(after.get(c.id), `${c.id} hash`).toBe(c.contentHash);
    }
    expect(r.diff.added).toEqual([`${TEXT}#banner`]);
  });
});

describe('content hash invariants', () => {
  it('whitespace-only edits (indentation, trailing spaces, blank lines, CRLF) keep every hash', async () => {
    const f = await fixture('ts-basic');
    const before = hashes((await scan(f)).chunks);
    const src = await f.read(STRINGS);
    const reformatted = src
      .split('\n')
      .map((l) => (l.startsWith('  ') ? `\t${l.trimStart()}   ` : l))
      .join('\n\n')
      .replace(/\n/g, '\r\n');
    await f.write(STRINGS, reformatted);
    await f.edit('src/util/math.ts', '  let total = 0;', '      let    total = 0;');
    const r = await scan(f);
    expect(hashes(r.chunks)).toEqual(before);
    expect(r.diff.changed).toEqual([]);
  });

  it('comment-only edits (line, block, JSDoc) keep every hash', async () => {
    const f = await fixture('ts-basic');
    const before = hashes((await scan(f)).chunks);
    await f.edit(STRINGS, 'export function slugify(', '/**\n * Turns any title into a URL slug.\n * @param input free text\n */\nexport function slugify(');
    await f.edit(STRINGS, '  let count = 0;', '  let count = 0; // running total\n  /* scan forward */');
    await f.edit(ENGINE, '        // listeners must not break the engine', '        // a listener threw; swallow it so the engine keeps going');
    const r = await scan(f);
    expect(hashes(r.chunks)).toEqual(before);
    expect(r.diff.changed).toEqual([]);
  });

  it('docstring and comment edits keep every hash (py)', async () => {
    const f = await fixture('py-basic');
    const before = hashes((await scan(f)).chunks);
    await f.edit(TEXT, '"""Lowercase, dash-separated identifier."""', '"""Lowercase, dash-separated identifier.\n\n    Empty input becomes "untitled".\n    """');
    await f.edit('app/models/user.py', '        # Tags are unique and lowercase.', '        # Tags are unique, stripped and lowercase.\n        # (duplicates are ignored)');
    const r = await scan(f);
    expect(hashes(r.chunks)).toEqual(before);
  });

  it('a semantic edit changes the hash of the leaf and its ancestors only', async () => {
    const f = await fixture('ts-basic');
    const before = (await scan(f)).chunks;
    await f.edit(STRINGS, "    return 'untitled';", "    return 'unnamed';");
    const r = await scan(f);
    expect(r.diff.changed.map((c) => c.id)).toEqual(['.', 'src', 'src/util', STRINGS, `${STRINGS}#~group:slugify`]);
    const after = hashes(r.chunks);
    for (const c of before.filter((x) => x.isLeaf && x.id !== `${STRINGS}#~group:slugify`)) {
      expect(after.get(c.id), c.id).toBe(c.contentHash);
    }
  });

  it('whitespace runs inside string literals collapse too (accepted imprecision), but removing a space is semantic', async () => {
    // PLAN.md §4 step 3: string literals are not special-cased.
    const f = await fixture('ts-basic');
    const before = hashes((await scan(f)).chunks);
    await f.edit(STRINGS, "const pad = ' '.repeat", "const pad = '   '.repeat");
    expect(hashes((await scan(f)).chunks).get(`${STRINGS}#~group:randomId`)).toBe(before.get(`${STRINGS}#~group:randomId`));
    await f.edit(STRINGS, "const pad = '   '.repeat", "const pad = ''.repeat");
    expect(hashes((await scan(f)).chunks).get(`${STRINGS}#~group:randomId`)).not.toBe(before.get(`${STRINGS}#~group:randomId`));
  });
});
