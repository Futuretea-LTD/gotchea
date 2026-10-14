import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.js';
import { MAX_TASK_LINES, generationCandidates, getGenerationTasks, poolTarget } from '../../src/generate/tasks.js';
import { FsChunkStore, initConfig, runScan, type Chunk } from '../../src/index.js';
import { FsQuestionStore, type QuestionPrivate } from '../../src/internal.js';

// ---------------------------------------------------------------------------
// generationCandidates (pure)
// ---------------------------------------------------------------------------

interface ChunkSpec {
  loc?: number;
  fanIn?: number;
  questionCount?: number;
  lines?: number;
  isLeaf?: boolean;
}

const chunk = (id: string, spec: ChunkSpec = {}): Chunk => ({
  id,
  kind: 'symbol',
  parentId: null,
  title: id,
  source: 'code',
  lang: 'typescript',
  ranges: [{ path: `${id}.ts`, start: 1, end: spec.lines ?? 20 }],
  contentHash: `hash-${id}`,
  metrics: { loc: spec.loc ?? 20, complexity: 1, fanIn: spec.fanIn ?? 0 },
  questionCount: spec.questionCount ?? 3,
  isLeaf: spec.isLeaf ?? true,
});

const cfg = resolveConfig();
const ids = (chunks: Chunk[], usable: Record<string, number> = {}, c = cfg) =>
  generationCandidates(chunks, new Map(Object.entries(usable)), c).map((x) => x.chunk.id);

describe('generationCandidates', () => {
  it('puts grey chunks (no usable questions) before chunks that have some', () => {
    const chunks = [chunk('a', { fanIn: 50, loc: 200, questionCount: 5 }), chunk('b', { fanIn: 0, loc: 10 })];
    expect(ids(chunks, { a: 1 })).toEqual(['b', 'a']);
  });

  it('orders by fanIn first among equals in greyness, even against a larger deficit and loc', () => {
    const chunks = [chunk('a', { fanIn: 1, loc: 200, questionCount: 5 }), chunk('b', { fanIn: 3, loc: 10, questionCount: 2 })];
    expect(ids(chunks)).toEqual(['b', 'a']);
    // same among chunks that already have questions
    expect(ids(chunks, { a: 1, b: 1 })).toEqual(['b', 'a']);
  });

  it('then by larger deficit, even against a larger loc', () => {
    const chunks = [chunk('a', { loc: 200, questionCount: 3 }), chunk('b', { loc: 10, questionCount: 5 })];
    expect(ids(chunks)).toEqual(['b', 'a']);
    // deficit, not questionCount: both have questions; a needs 6 − 1 = 5, b needs 10 − 6 = 4
    expect(generationCandidates(chunks, new Map([['a', 1], ['b', 6]]), cfg).map((c) => [c.chunk.id, c.deficit])).toEqual([
      ['a', 5],
      ['b', 4],
    ]);
  });

  it('then by larger loc', () => {
    const chunks = [chunk('a', { loc: 20 }), chunk('b', { loc: 50 })];
    expect(ids(chunks)).toEqual(['b', 'a']);
  });

  it('breaks full ties by id, independent of input order', () => {
    expect(ids([chunk('b'), chunk('a'), chunk('c')])).toEqual(['a', 'b', 'c']);
    expect(ids([chunk('c'), chunk('a'), chunk('b')])).toEqual(['a', 'b', 'c']);
  });

  it('ignores fanIn when fanInWeight is 0', () => {
    const noFanIn = resolveConfig({ quiz: { fanInWeight: 0 } });
    const chunks = [chunk('a', { fanIn: 0, loc: 50 }), chunk('b', { fanIn: 9, loc: 10 })];
    expect(ids(chunks, {}, noFanIn)).toEqual(['a', 'b']);
  });

  it('drops leaves below minLoc', () => {
    expect(cfg.questions.minLoc).toBe(5);
    expect(ids([chunk('small', { loc: 4 }), chunk('ok', { loc: 5 })])).toEqual(['ok']);
    expect(ids([chunk('small', { loc: 4 })], {}, resolveConfig({ questions: { minLoc: 0 } }))).toEqual(['small']);
  });

  it(`drops chunks with more than MAX_TASK_LINES (${MAX_TASK_LINES}) lines`, () => {
    expect(ids([chunk('big', { lines: MAX_TASK_LINES + 1 }), chunk('edge', { lines: MAX_TASK_LINES })])).toEqual(['edge']);
  });

  it('counts lines over all ranges for the size guard', () => {
    const multi: Chunk = {
      ...chunk('multi'),
      ranges: [
        { path: 'multi.ts', start: 1, end: 500 },
        { path: 'multi.ts', start: 600, end: 900 },
      ],
    };
    expect(ids([multi])).toEqual([]);
  });

  it('drops non-leaf chunks', () => {
    expect(ids([chunk('mod', { isLeaf: false }), chunk('leaf')])).toEqual(['leaf']);
  });

  it('drops chunks whose pool is full', () => {
    // questionCount 3 × poolMultiplier 2 = 6
    expect(ids([chunk('full'), chunk('over'), chunk('open')], { full: 6, over: 9, open: 5 })).toEqual(['open']);
  });

  it('count = min(deficit, questionCount, maxBatch) and reports usable/target/deficit', () => {
    const chunks = [chunk('fresh', { questionCount: 3 }), chunk('almost', { questionCount: 3 }), chunk('wide', { questionCount: 5 })];
    const out = generationCandidates(chunks, new Map([['almost', 4]]), cfg);
    const byId = Object.fromEntries(out.map((c) => [c.chunk.id, c]));
    expect(byId.fresh).toMatchObject({ usable: 0, target: 6, deficit: 6, count: 3 }); // questionCount caps
    expect(byId.almost).toMatchObject({ usable: 4, target: 6, deficit: 2, count: 2 }); // deficit caps
    expect(byId.wide).toMatchObject({ usable: 0, target: 10, deficit: 10, count: 5 });

    const small = resolveConfig({ questions: { maxBatch: 2 } });
    expect(generationCandidates([chunk('wide', { questionCount: 5 })], new Map(), small)[0]).toMatchObject({ count: 2 }); // maxBatch caps
  });

  it('poolTarget rounds up', () => {
    expect(poolTarget({ questionCount: 3 }, { poolMultiplier: 1.5 })).toBe(5);
    expect(poolTarget({ questionCount: 3 }, { poolMultiplier: 2 })).toBe(6);
    expect(ids([chunk('a')], { a: 4 }, resolveConfig({ questions: { poolMultiplier: 1.5 } }))).toEqual(['a']);
    expect(ids([chunk('a')], { a: 5 }, resolveConfig({ questions: { poolMultiplier: 1.5 } }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getGenerationTasks (temp repo)
// ---------------------------------------------------------------------------

const SOURCES: Record<string, string> = {
  'src/math.ts': [
    'export function clamp(n: number, lo: number, hi: number): number {',
    '  if (n < lo) return lo;',
    '  if (n > hi) return hi;',
    '  return n;',
    '}',
    '',
    'export function add(a: number, b: number): number {',
    '  const sum = a + b;',
    '  return sum;',
    '}',
    '',
  ].join('\n'),
  'src/index.ts': [
    "import { clamp } from './math.js';",
    '',
    'export function limit(n: number): number {',
    '  const lo = 0;',
    '  const hi = 10;',
    '  const out = clamp(n, lo, hi);',
    '  return out;',
    '}',
    '',
  ].join('\n'),
};

interface Repo {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'gotchea-tasks-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-tasks-home-'));
  for (const [path, text] of Object.entries(SOURCES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  return {
    root,
    env: { ...process.env, GOTCHEA_HOME: home },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

const question = (id: string, c: Chunk, stem: string, extra: Partial<QuestionPrivate> = {}): QuestionPrivate => ({
  id,
  chunkId: c.id,
  chunkHash: c.contentHash,
  chunkLines: 10,
  type: 'behavior',
  stem,
  options: ['SEED-OPT-A', 'SEED-OPT-B', 'SEED-OPT-C', 'SEED-OPT-D'],
  correctIndex: 1,
  explanation: 'SEED-EXPLANATION cites L3.',
  refs: [{ start: 3, end: 3 }],
  difficulty: 1,
  lang: 'en',
  generatedBy: 'test',
  promptVersion: 'p1',
  status: 'ok',
  flagged: false,
  verifiedBy: null,
  createdAt: '2026-10-14T12:00:00.000Z',
  ...extra,
});

describe('getGenerationTasks', () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = await createRepo();
    await initConfig(repo.root);
  });
  afterEach(() => repo.cleanup());

  const scan = async () => {
    await runScan(repo.root, { env: repo.env });
    return (await new FsChunkStore(repo.root).load())!.chunks;
  };

  it('returns null before the first scan', async () => {
    expect(await getGenerationTasks(repo.root)).toBeNull();
  });

  it('builds prioritised tasks with numbered code, hash, imports and type plan', async () => {
    const chunks = await scan();
    const math = chunks.find((c) => c.id === 'src/math.ts')!;
    const index = chunks.find((c) => c.id === 'src/index.ts')!;
    expect(math.isLeaf && index.isLeaf).toBe(true);

    const res = (await getGenerationTasks(repo.root))!;
    expect(res.changedSinceScan).toEqual([]);
    expect(res.remaining).toBe(0);
    // math.ts is imported by index.ts (fanIn 1): it comes first
    expect(res.tasks.map((t) => t.chunkId)).toEqual(['src/math.ts', 'src/index.ts']);

    const [mt, it2] = res.tasks as [(typeof res.tasks)[0], (typeof res.tasks)[0]];
    expect(mt.chunkHash).toBe(math.contentHash);
    expect(it2.chunkHash).toBe(index.contentHash);
    expect(mt).toMatchObject({ path: 'src/math.ts', sourceLang: 'typescript', questionLang: 'en', lineCount: 10 });

    // numbering is chunk-relative from 1 (10 lines → width 2)
    expect(mt.code.split('\n')[0]).toBe(' 1 | export function clamp(n: number, lo: number, hi: number): number {');
    expect(mt.code.split('\n')).toHaveLength(10);
    expect(it2.code.startsWith("1 | import { clamp } from './math.js';")).toBe(true);

    expect(it2.context.imports).toHaveLength(1);
    expect(it2.context.imports[0]).toMatchObject({ from: './math.js', name: 'clamp' });
    expect(it2.context.imports[0]!.signature.startsWith('export function clamp')).toBe(true);
    expect(mt.context.imports).toEqual([]);
    expect(it2.context.enclosing).toBeNull(); // parent is a module, not a symbol

    for (const t of res.tasks) {
      expect(t.count).toBe(3); // min(deficit 6, questionCount 3, maxBatch 20)
      expect(t.typePlan).toHaveLength(t.count);
      expect(t.existingStems).toEqual([]);
    }
    expect(mt.typePlan).toEqual(['behavior', 'edge_case', 'purpose']);
  });

  it('limit pages the candidates and reports the remainder', async () => {
    await scan();
    const res = (await getGenerationTasks(repo.root, { limit: 1 }))!;
    expect(res.tasks.map((t) => t.chunkId)).toEqual(['src/math.ts']);
    expect(res.remaining).toBe(1);
  });

  it('existingStems carries usable stems only, and count/typePlan account for them', async () => {
    const chunks = await scan();
    const math = chunks.find((c) => c.id === 'src/math.ts')!;
    await new FsQuestionStore(repo.root).save(math.id, [
      question('q_000000000001', math, 'SEED-OK-STEM about clamp?'),
      question('q_000000000002', math, 'SEED-FLAGGED-STEM about clamp?', { flagged: true }),
      question('q_000000000003', math, 'SEED-STALE-STEM about clamp?', { status: 'stale' }),
      question('q_000000000004', math, 'SEED-OLD-HASH-STEM about clamp?', { chunkHash: 'old-hash' }),
    ]);

    const res = (await getGenerationTasks(repo.root))!;
    // math.ts now has a usable question, so the grey index.ts comes first
    expect(res.tasks.map((t) => t.chunkId)).toEqual(['src/index.ts', 'src/math.ts']);
    const mt = res.tasks[1]!;
    expect(mt.existingStems).toEqual(['SEED-OK-STEM about clamp?']);
    expect(mt.count).toBe(3); // deficit 5, questionCount 3
    expect(mt.typePlan).toHaveLength(3);
    expect(mt.typePlan[0]).not.toBe('behavior'); // least represented type first

    const json = JSON.stringify(res);
    expect(json).not.toMatch(/SEED-FLAGGED-STEM|SEED-STALE-STEM|SEED-OLD-HASH-STEM|SEED-OPT|SEED-EXPLANATION|correctIndex|explanation/);
  });

  it('drops chunks whose pool is full', async () => {
    const chunks = await scan();
    const math = chunks.find((c) => c.id === 'src/math.ts')!;
    await new FsQuestionStore(repo.root).save(
      math.id,
      Array.from({ length: 6 }, (_, i) => question(`q_00000000001${i}`, math, `SEED stem number ${i} for clamp?`)),
    );
    const res = (await getGenerationTasks(repo.root))!;
    expect(res.tasks.map((t) => t.chunkId)).toEqual(['src/index.ts']);
  });

  it('uses the requested lang and throws on an invalid one', async () => {
    await scan();
    const res = (await getGenerationTasks(repo.root, { lang: 'pt-BR' }))!;
    expect(res.tasks.every((t) => t.questionLang === 'pt-BR')).toBe(true);
    await expect(getGenerationTasks(repo.root, { lang: 'Turkish' })).rejects.toThrow();
  });

  it('skips a chunk edited after the scan and lists it in changedSinceScan', async () => {
    await scan();
    const path = join(repo.root, 'src/math.ts');
    await writeFile(path, (await readFile(path, 'utf8')).replace('  return n;', '  return n * 2;'));

    const res = (await getGenerationTasks(repo.root))!;
    expect(res.changedSinceScan).toEqual(['src/math.ts']);
    expect(res.tasks.map((t) => t.chunkId)).toEqual(['src/index.ts']);
    expect(res.remaining).toBe(0);
  });
});
