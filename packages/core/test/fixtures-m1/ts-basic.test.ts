// Fixture `ts-basic`: chunk hierarchy, leaf sizes, config thresholds, filters and fanIn.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig, resolveConfig } from '../../src/config/load.js';
import type { GotcheaConfigInput } from '../../src/config/schema.js';
import { scanRepo } from '../../src/scan/scan.js';
import { copyFixture, type FixtureRepo } from '../helpers/fixture-repo.js';
import { byId, childrenOf, expectTreeInvariants, leavesOf } from '../helpers/tree-invariants.js';

let f: FixtureRepo;
const scan = (over: GotcheaConfigInput = {}) =>
  scanRepo({ root: f.root, repoId: 'ts-basic', useGit: false, env: f.env, config: resolveConfig(mergeConfig({}, over)), dryRun: true });

beforeEach(async () => {
  f = await copyFixture('ts-basic');
});
afterEach(async () => {
  await f.cleanup();
});

const STRINGS = 'src/util/strings.ts';
const ENGINE = 'src/services/report-engine.ts';

describe('ts-basic: files', () => {
  it('scans only source files and skips node_modules, dist, lockfiles, *.min.js, gitignored files and tests', async () => {
    const r = await scan();
    expect(r.files).toEqual([
      'src/index.ts',
      'src/models/user.ts',
      ENGINE,
      'src/services/user-service.ts',
      'src/util/math.ts',
      STRINGS,
    ]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      'node_modules/': 'always',
      'dist/': 'always',
      'package-lock.json': 'always',
      'public/vendor.min.js': 'always',
      'src/util/strings.spec.ts': 'test',
    });
    // Gitignored files are dropped silently: neither scanned nor reported.
    const everything = [...r.files, ...r.skipped.map((s) => s.path), ...r.chunks.map((c) => c.id)];
    expect(everything.filter((p) => p.includes('config.local'))).toEqual([]);
    expect(r.chunks.some((c) => /node_modules|dist\/|\.min\.js|\.spec\.ts|package-lock/.test(c.id))).toBe(false);
    expect(r.parseFailures).toEqual([]);
  });

  it('includes the test file only with includeTests=true', async () => {
    const r = await scan({ includeTests: true });
    expect(r.files).toContain('src/util/strings.spec.ts');
    expect(r.skipped.map((s) => s.path)).not.toContain('src/util/strings.spec.ts');
    const spec = byId(r.chunks).get('src/util/strings.spec.ts')!;
    expect(spec).toMatchObject({ kind: 'file', isLeaf: true, parentId: 'src/util' });
    // The spec imports strings.ts, so strings.ts gains an importer.
    expect(byId(r.chunks).get(STRINGS)!.metrics.fanIn).toBe(5);
  });
});

describe('ts-basic: hierarchy', () => {
  it('builds module > file > group/symbol with the expected kinds', async () => {
    const { chunks } = await scan();
    expectTreeInvariants(chunks, defaultConfig().chunking);
    const map = byId(chunks);

    expect(chunks.filter((c) => c.kind === 'module').map((c) => c.id)).toEqual(['.', 'src', 'src/models', 'src/services', 'src/util']);
    expect(chunks.filter((c) => c.kind === 'file').map((c) => c.id)).toEqual([
      'src/index.ts',
      'src/models/user.ts',
      ENGINE,
      'src/services/user-service.ts',
      'src/util/math.ts',
      STRINGS,
    ]);
    // Small files are single leaves.
    for (const id of ['src/index.ts', 'src/models/user.ts', 'src/services/user-service.ts', 'src/util/math.ts']) {
      expect(map.get(id)!.isLeaf, id).toBe(true);
    }
    expect(map.get(STRINGS)!.isLeaf).toBe(false);
    expect(map.get(ENGINE)!.isLeaf).toBe(false);
  });

  it('merges the many tiny helpers of strings.ts into groups; a long helper breaks the run', async () => {
    const { chunks } = await scan();
    const kids = childrenOf(chunks, STRINGS);
    expect(kids.map((c) => c.id).sort()).toEqual(
      [
        `${STRINGS}#~group:slugify`,
        `${STRINGS}#~group:truncate`,
        `${STRINGS}#countOccurrences`,
        `${STRINGS}#wordWrap`,
        `${STRINGS}#~group:stripTags`,
        `${STRINGS}#~group:compareIgnoreCase`,
        `${STRINGS}#~group:randomId`,
        `${STRINGS}#~top`,
      ].sort(),
    );
    const cfg = defaultConfig().chunking;
    const groups = kids.filter((c) => c.kind === 'group');
    expect(groups).toHaveLength(5);
    for (const g of groups) {
      // Several members, each separated by blank lines → one range per member.
      expect(g.ranges.length, g.id).toBeGreaterThanOrEqual(2);
      expect(g.metrics.loc).toBeLessThanOrEqual(cfg.leafMaxLoc);
    }
    // Greedy merge stops once a group reaches leafMinLoc...
    const slug = byId(chunks).get(`${STRINGS}#~group:slugify`)!;
    expect(slug.metrics.loc).toBeGreaterThanOrEqual(cfg.leafMinLoc);
    expect(slug.title).toBe('slugify … snakeCase (5)');
    // ...a leftover single member stays a symbol, and wordWrap (>= mergeBelowLoc) is never grouped.
    const ww = byId(chunks).get(`${STRINGS}#wordWrap`)!;
    expect(ww.kind).toBe('symbol');
    expect(ww.metrics.loc).toBeGreaterThanOrEqual(cfg.mergeBelowLoc);
    expect(byId(chunks).get(`${STRINGS}#countOccurrences`)!.kind).toBe('symbol');
    // Leaves tile the file: their LOC adds up to the file's LOC.
    const leafLoc = leavesOf(chunks, STRINGS).reduce((s, c) => s + c.metrics.loc, 0);
    expect(leafLoc).toBe(byId(chunks).get(STRINGS)!.metrics.loc);
  });

  it('splits the oversized ReportEngine class into methods, nested groups and ~body', async () => {
    const { chunks } = await scan();
    const cfg = defaultConfig().chunking;
    const cls = byId(chunks).get(`${ENGINE}#ReportEngine`)!;
    expect(cls).toMatchObject({ kind: 'symbol', isLeaf: false, questionCount: 0 });
    expect(cls.metrics.loc).toBeGreaterThan(cfg.splitAboveLoc);

    const kids = childrenOf(chunks, cls.id);
    const ids = kids.map((c) => c.id.slice(cls.id.length + 1));
    expect(ids).toEqual(expect.arrayContaining(['addRow', 'summarize', 'formatAmount', 'fromCsv', '~body', '~group:constructor']));
    expect(kids.filter((c) => c.kind === 'group').length).toBeGreaterThanOrEqual(1);
    for (const k of kids) {
      expect(k.isLeaf, k.id).toBe(true);
      expect(k.metrics.loc, k.id).toBeLessThanOrEqual(cfg.leafMaxLoc);
    }
    // The tiny constructor/getters merged into one nested group.
    const ctor = byId(chunks).get(`${cls.id}.~group:constructor`)!;
    expect(ctor.title).toMatch(/^constructor … onChange \(\d+\)$/);
    // ~body = class header, fields and closing brace: the lines no method covers.
    const body = byId(chunks).get(`${cls.id}.~body`)!;
    expect(body.ranges[0]!.start).toBe(cls.ranges[0]!.start);
    expect(body.ranges[body.ranges.length - 1]!.end).toBe(cls.ranges[0]!.end);
    // The class's leaves account for every one of its normalized lines.
    expect(leavesOf(chunks, ENGINE).filter((c) => c.id.startsWith(`${cls.id}.`)).reduce((s, c) => s + c.metrics.loc, 0)).toBe(cls.metrics.loc);
  });

  it('keeps every leaf within the size thresholds', async () => {
    const { chunks } = await scan();
    const cfg = defaultConfig().chunking;
    for (const leaf of chunks.filter((c) => c.isLeaf)) {
      if (leaf.kind === 'file' || leaf.kind === 'group') expect(leaf.metrics.loc, leaf.id).toBeLessThanOrEqual(cfg.leafMaxLoc);
      else expect(leaf.metrics.loc, leaf.id).toBeLessThanOrEqual(cfg.splitAboveLoc);
      expect([3, 5, 7]).toContain(leaf.questionCount);
    }
  });
});

describe('ts-basic: thresholds from config change the output', () => {
  it('leafMaxLoc above the biggest file makes every file a single leaf', async () => {
    const { chunks } = await scan({ chunking: { leafMaxLoc: 1000 } });
    expect(chunks.filter((c) => c.kind === 'group' || c.kind === 'symbol')).toEqual([]);
    expect(chunks.filter((c) => c.isLeaf).every((c) => c.kind === 'file')).toBe(true);
  });

  it('mergeBelowLoc 1 disables grouping (no symbol is under 1 LOC)', async () => {
    const { chunks } = await scan({ chunking: { mergeBelowLoc: 1 } });
    expect(chunks.filter((c) => c.kind === 'group')).toEqual([]);
    expect(childrenOf(chunks, STRINGS).map((c) => c.id)).toContain(`${STRINGS}#slugify`);
  });

  it('a smaller leafMinLoc yields more, smaller groups', async () => {
    const base = (await scan()).chunks.filter((c) => c.kind === 'group');
    const small = (await scan({ chunking: { leafMinLoc: 15 } })).chunks.filter((c) => c.kind === 'group');
    expect(small.length).toBeGreaterThan(base.length);
    expect(Math.max(...small.map((g) => g.metrics.loc))).toBeLessThan(Math.max(...base.map((g) => g.metrics.loc)));
  });

  it('splitAboveLoc above the class size keeps ReportEngine a single (oversized) leaf', async () => {
    const { chunks } = await scan({ chunking: { splitAboveLoc: 1000 } });
    const cls = byId(chunks).get(`${ENGINE}#ReportEngine`)!;
    expect(cls.isLeaf).toBe(true);
    expect(childrenOf(chunks, cls.id)).toEqual([]);
  });

  it('question bands drive questionCount', async () => {
    const { chunks } = await scan({ questions: { bands: [{ count: 9 }] } });
    expect(new Set(chunks.filter((c) => c.isLeaf).map((c) => c.questionCount))).toEqual(new Set([9]));
  });

  it('exclude/ignore globs drop files', async () => {
    const { files } = await scan({ ignore: ['src/services/**'] });
    expect(files.some((p) => p.startsWith('src/services/'))).toBe(false);
  });
});

describe('ts-basic: fanIn', () => {
  it('counts distinct importing files for files and modules', async () => {
    const map = byId((await scan()).chunks);
    const fanIn = (id: string) => map.get(id)!.metrics.fanIn;
    expect(fanIn(STRINGS)).toBe(4); // user.ts, user-service.ts, report-engine.ts, index.ts
    expect(fanIn('src/util/math.ts')).toBe(3); // strings.ts, user-service.ts, report-engine.ts
    expect(fanIn('src/models/user.ts')).toBe(2); // user-service.ts, index.ts
    expect(fanIn(ENGINE)).toBe(1); // index.ts
    expect(fanIn('src/services/user-service.ts')).toBe(1);
    expect(fanIn('src/index.ts')).toBe(0);
    // Modules count importers outside the directory (strings.ts → math.ts is internal).
    expect(fanIn('src/util')).toBe(4);
    expect(fanIn('src/services')).toBe(1);
    expect(fanIn('src')).toBe(0);
  });

  it('counts referencing files per symbol, the union of members for groups, and 0 for ~top/~body', async () => {
    const map = byId((await scan()).chunks);
    const fanIn = (id: string) => map.get(id)!.metrics.fanIn;
    expect(fanIn(`${STRINGS}#~group:slugify`)).toBe(3); // slugify: user.ts, user-service.ts, index.ts
    expect(fanIn(`${STRINGS}#~group:truncate`)).toBe(2); // truncate/padLeft/padRight: user-service.ts, report-engine.ts
    expect(fanIn(`${STRINGS}#wordWrap`)).toBe(0);
    expect(fanIn(`${ENGINE}#ReportEngine`)).toBe(1);
    // A method counts files that import its owner and use the method name.
    expect(fanIn(`${ENGINE}#ReportEngine.addRow`)).toBe(1);
    expect(fanIn(`${ENGINE}#ReportEngine.merge`)).toBe(0);
    expect(fanIn(`${STRINGS}#~top`)).toBe(0);
    expect(fanIn(`${ENGINE}#ReportEngine.~body`)).toBe(0);
  });
});
