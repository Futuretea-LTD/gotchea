import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROMPT_VERSION } from '../../src/generate/prompt.js';
import { saveQuestions, type SaveInput, type SaveResult } from '../../src/generate/save.js';
import {
  FsChunkStore,
  chunkLineCount,
  initConfig,
  loadMapTree,
  okQuestionCounts,
  repoPaths,
  runScan,
  toAbsoluteLine,
  type Chunk,
  type MapNode,
} from '../../src/index.js';
import { FsQuestionStore } from '../../src/internal.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const BY = 'host:test';

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

// src/math.ts is a 10-line file leaf.
const CLAMP_HI = {
  type: 'behavior',
  stem: 'What does clamp(15, 0, 10) return?',
  options: ['returns hi', 'returns lo', 'returns n', 'throws error'],
  correctIndex: 0,
  explanation: 'L3 returns hi when n > hi, so the result is 10.',
  refs: [{ start: 3, end: 3 }],
  difficulty: 1,
};
const ADD_SUM = {
  type: 'edge_case',
  stem: 'If add receives 2 and 3, what is the resulting value?',
  options: ['five', 'six', 'twenty-three', 'minus one'],
  correctIndex: 0,
  explanation: 'L8 computes a + b and L9 returns it, so the value is 5.',
  refs: [{ start: 8, end: 9 }],
  difficulty: 1,
};
const CLAMP_LO = {
  type: 'purpose',
  stem: 'Why does the first guard compare n against lo before anything else?',
  options: ['enforce lower bound', 'enforce upper bound', 'skip validation', 'convert to integer'],
  correctIndex: 0,
  explanation: 'L2 returns lo for any n below it, which enforces the lower bound.',
  refs: [{ start: 2, end: 2 }],
  difficulty: 2,
};
const OUT_OF_RANGE = {
  type: 'impact',
  stem: 'REJECT-STEM-RANGE what breaks if the final return is removed?',
  options: ['REJ-OPT-alpha', 'REJ-OPT-bravo', 'REJ-OPT-charlie', 'REJ-OPT-delta'],
  correctIndex: 2,
  explanation: 'L4 is the fallthrough return; removing it changes the type.',
  refs: [{ start: 4, end: 99 }],
  difficulty: 2,
};
const SKEWED = {
  type: 'behavior',
  stem: 'REJECT-STEM-SKEW what happens when lo equals hi in clamp?',
  options: ['REJ-OPT-a-very-much-longer-correct-option-text-here', 'REJ-OPT-x', 'REJ-OPT-y', 'REJ-OPT-z'],
  correctIndex: 0,
  explanation: 'L2 and L3 both compare against the same bound.',
  refs: [{ start: 2, end: 3 }],
  difficulty: 2,
};
const MISSING_OPTIONS = {
  type: 'behavior',
  stem: 'REJECT-STEM-SCHEMA what does clamp do with NaN?',
  explanation: 'L2 and L3 are both false for NaN, so L4 returns it.',
  refs: [{ start: 4, end: 4 }],
  difficulty: 1,
};

interface Repo {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'gotchea-save-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-save-home-'));
  for (const [path, text] of Object.entries(SOURCES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  return {
    root,
    env: { ...process.env, GOTCHEA_HOME: home },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

let repo: Repo;
let chunks: Chunk[];
let math: Chunk;

const scan = async () => {
  await runScan(repo.root, { env: repo.env });
  chunks = (await new FsChunkStore(repo.root).load())!.chunks;
  math = chunks.find((c) => c.id === 'src/math.ts')!;
};

beforeEach(async () => {
  repo = await createRepo();
  await initConfig(repo.root);
  await scan();
  expect(math.isLeaf).toBe(true);
});
afterEach(() => repo.cleanup());

const save = (input: Partial<SaveInput> & Pick<SaveInput, 'questions'>) =>
  saveQuestions(repo.root, { chunkId: math.id, chunkHash: math.contentHash, ...input }, { generatedBy: BY, now: NOW });

const saved = (r: SaveResult) => {
  if (r.status !== 'saved') throw new Error(`expected saved, got ${r.status}: ${r.reason}`);
  return r;
};

const poolPath = (chunkId: string) => new FsQuestionStore(repo.root).pathFor(chunkId);
const pool = (chunkId = math.id) => new FsQuestionStore(repo.root).list(chunkId);
const questionsDirListing = async () => (await readdir(repoPaths(repo.root).questionsDir).catch(() => [])).sort();

describe('saveQuestions: accepted and rejected items', () => {
  it('persists accepted items with stamped fields and never persists rejected ones', async () => {
    const items = [CLAMP_HI, OUT_OF_RANGE, ADD_SUM, SKEWED, MISSING_OPTIONS];
    const r = saved(await save({ questions: items }));

    expect(r.chunkId).toBe(math.id);
    expect(r.accepted.map((a) => a.index)).toEqual([0, 2]);
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([
      [1, 'refs_out_of_range'],
      [3, 'length_skew'],
      [4, 'schema_invalid'],
    ]);
    expect(r.usableQuestions).toBe(2);
    expect(r.target).toBe(6);

    for (const rej of r.rejected) {
      expect(Object.keys(rej).sort()).toEqual(['detail', 'index', 'reason']);
      expect(typeof rej.detail).toBe('string');
      expect(rej.detail.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(rej.detail).not.toContain(item.stem);
        for (const opt of ('options' in item ? item.options : []) as string[]) expect(rej.detail).not.toContain(opt);
      }
      expect(rej.detail).not.toMatch(/REJ-OPT|REJECT-STEM/);
    }
    // the result carries no question content at all
    expect(JSON.stringify(r)).not.toMatch(/REJ-OPT|REJECT-STEM|returns hi|five|clamp\(15|explanation|correctIndex/);

    const stored = await pool();
    expect(stored.map((q) => q.id).sort()).toEqual(r.accepted.map((a) => a.id).sort());
    expect(stored.map((q) => q.stem).sort()).toEqual([ADD_SUM.stem, CLAMP_HI.stem].sort());
    for (const q of stored) {
      expect(q).toMatchObject({
        chunkId: math.id,
        chunkHash: math.contentHash,
        chunkLines: 10,
        lang: 'en',
        generatedBy: BY,
        status: 'ok',
        flagged: false,
        verifiedBy: null,
        promptVersion: PROMPT_VERSION,
        createdAt: NOW.toISOString(),
      });
      expect(q.id).toMatch(/^q_[0-9a-f]{12}$/);
    }
    const hi = stored.find((q) => q.stem === CLAMP_HI.stem)!;
    expect(hi).toMatchObject({ options: CLAMP_HI.options, correctIndex: 0, refs: [{ start: 3, end: 3 }], type: 'behavior' });
  });

  it('stamps an explicit lang', async () => {
    const r = saved(await save({ lang: 'pt-BR', questions: [CLAMP_HI] }));
    expect(r.accepted).toHaveLength(1);
    expect((await pool())[0]!.lang).toBe('pt-BR');
  });

  it("returns 'saved' with zero accepted when every item is rejected, and writes nothing", async () => {
    const r = saved(await save({ questions: [OUT_OF_RANGE] }));
    expect(r.accepted).toEqual([]);
    expect(r.usableQuestions).toBe(0);
    expect(await questionsDirListing()).toEqual([]);
  });

  it('rejects an identical resubmission as duplicate_stored', async () => {
    const first = saved(await save({ questions: [CLAMP_HI] }));
    expect(first.accepted).toHaveLength(1);
    const before = await readFile(poolPath(math.id));

    const again = saved(await save({ questions: [CLAMP_HI] }));
    expect(again.accepted).toEqual([]);
    expect(again.rejected).toEqual([{ index: 0, reason: 'duplicate_stored', detail: expect.stringContaining(first.accepted[0]!.id) }]);
    expect(again.usableQuestions).toBe(1);
    expect(await readFile(poolPath(math.id))).toEqual(before);
  });

  it('keeps both batches of two concurrent saves on one chunk', async () => {
    const [a, b] = await Promise.all([save({ questions: [CLAMP_HI] }), save({ questions: [ADD_SUM, CLAMP_LO] })]);
    expect(saved(a).accepted).toHaveLength(1);
    expect(saved(b).accepted).toHaveLength(2);
    expect((await pool()).map((q) => q.stem).sort()).toEqual([ADD_SUM.stem, CLAMP_HI.stem, CLAMP_LO.stem].sort());
  });

  it('after a save, the map shows the leaf with okQuestions = n and colour red', async () => {
    const before = await loadMapTree(repo.root, { env: repo.env, now: NOW });
    const find = (root: MapNode | null, id: string): MapNode | undefined => {
      if (!root) return undefined;
      if (root.id === id) return root;
      for (const c of root.children) {
        const hit = find(c, id);
        if (hit) return hit;
      }
      return undefined;
    };
    expect(find(before!.root, math.id)).toMatchObject({ okQuestions: 0, state: { color: 'grey' } });

    saved(await save({ questions: [CLAMP_HI, ADD_SUM] }));
    const after = await loadMapTree(repo.root, { env: repo.env, now: NOW });
    expect(find(after!.root, math.id)).toMatchObject({ okQuestions: 2, state: { color: 'red' } });
    expect(find(after!.root, 'src/index.ts')).toMatchObject({ okQuestions: 0, state: { color: 'grey' } });
  });
});

describe('saveQuestions: call-level gate persists nothing', () => {
  /** Seeds the math pool, runs `call`, and asserts the result plus byte-identical storage. */
  const expectGate = async (call: () => Promise<SaveResult>, reason: string, prepare?: () => Promise<void>) => {
    saved(await save({ questions: [CLAMP_HI] }));
    await prepare?.();
    const listing = await questionsDirListing();
    const bytes = await readFile(poolPath(math.id));

    const r = await call();
    expect(r.status).toBe('rejected');
    if (r.status !== 'rejected') return;
    expect(r.reason).toBe(reason);
    expect(typeof r.message).toBe('string');
    expect(Object.keys(r).sort()).toEqual(['chunkId', 'message', 'reason', 'status']);
    expect(JSON.stringify(r)).not.toMatch(/clamp\(15|returns hi|explanation|correctIndex/);

    expect(await readFile(poolPath(math.id))).toEqual(bytes);
    expect(await questionsDirListing()).toEqual(listing);
    return r;
  };

  it('chunk_hash_mismatch', async () => {
    const r = await expectGate(() => save({ chunkHash: 'not-the-hash', questions: [CLAMP_LO] }), 'chunk_hash_mismatch');
    // the current hash is not handed back
    expect(r!.message).not.toContain(math.contentHash);
  });

  it('unknown_chunk', async () => {
    await expectGate(() => save({ chunkId: 'src/nope.ts', questions: [CLAMP_LO] }), 'unknown_chunk');
  });

  it('not_leaf', async () => {
    const mod = chunks.find((c) => c.id === 'src')!;
    expect(mod.isLeaf).toBe(false);
    await expectGate(() => save({ chunkId: mod.id, chunkHash: mod.contentHash, questions: [CLAMP_LO] }), 'not_leaf');
  });

  it('chunk_changed_since_scan', async () => {
    const path = join(repo.root, 'src/math.ts');
    await expectGate(
      () => save({ questions: [CLAMP_LO] }),
      'chunk_changed_since_scan',
      async () => writeFile(path, (await readFile(path, 'utf8')).replace('  return n;', '  return n * 2;')),
    );
  });

  it('chunk_changed_since_scan when an unscanned comment shifts the chunk (same hash, other lines)', async () => {
    const path = join(repo.root, 'src/math.ts');
    await expectGate(
      () => save({ questions: [CLAMP_LO] }),
      'chunk_changed_since_scan',
      async () => writeFile(path, `// one\n// two\n${await readFile(path, 'utf8')}`),
    );
  });

  it('chunk_changed_since_scan when the file was deleted', async () => {
    await expectGate(
      () => save({ questions: [CLAMP_LO] }),
      'chunk_changed_since_scan',
      () => rm(join(repo.root, 'src/math.ts')),
    );
  });

  it('lang_invalid', async () => {
    await expectGate(() => save({ lang: 'Turkish', questions: [CLAMP_LO] }), 'lang_invalid');
  });

  it('batch_too_large', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...CLAMP_LO, stem: `Variant ${i}: ${CLAMP_LO.stem}` }));
    await expectGate(() => save({ questions: many }), 'batch_too_large');
  });

  it('not_scanned', async () => {
    await rm(repoPaths(repo.root).chunks);
    const r = await saveQuestions(repo.root, { chunkId: math.id, chunkHash: math.contentHash, questions: [CLAMP_HI] }, { generatedBy: BY });
    expect(r).toMatchObject({ status: 'rejected', reason: 'not_scanned' });
    expect(await questionsDirListing()).toEqual([]);
  });
});

describe('saveQuestions: alias resolution', () => {
  it('resolves an old chunk id to the current one', async () => {
    await rename(join(repo.root, 'src/math.ts'), join(repo.root, 'src/numbers.ts'));
    const path = join(repo.root, 'src/index.ts');
    await writeFile(path, (await readFile(path, 'utf8')).replace("'./math.js'", "'./numbers.js'"));
    execFileSync('git', ['add', '-A'], { cwd: repo.root, stdio: 'ignore' });
    const oldId = math.id;
    await scan();
    const moved = chunks.find((c) => c.id === 'src/numbers.ts')!;
    expect(moved.aliases).toContain(oldId);
    expect(chunks.some((c) => c.id === oldId)).toBe(false);

    const r = saved(
      await saveQuestions(repo.root, { chunkId: oldId, chunkHash: moved.contentHash, questions: [CLAMP_HI] }, { generatedBy: BY, now: NOW }),
    );
    expect(r.chunkId).toBe(moved.id);
    expect(r.accepted).toHaveLength(1);
    const stored = await pool(moved.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.chunkId).toBe(moved.id);
  });
});

describe('chunk-relative refs survive a move (D1)', () => {
  /** ~110-line functions: the file is over `splitAboveLoc`, so each function is its own leaf. */
  const bigFunction = (name: string): string[] => [
    `export function ${name}(x: number): number {`,
    ...Array.from({ length: 108 }, (_, i) => `  x += ${i} * x;`),
    '  return x;',
    '}',
    '',
  ];
  const BETA_Q = {
    type: 'behavior',
    stem: 'What does beta return when it is called with 0?',
    options: ['It returns 0', 'It returns 1', 'It returns 107', 'It returns NaN'],
    correctIndex: 0,
    explanation: 'L2-L109 only ever multiply x by (1 + i), so 0 stays 0 and L110 returns it.',
    refs: [
      { start: 2, end: 3 },
      { start: 110, end: 110 },
    ],
    difficulty: 1,
  };

  it('moving a chunk keeps status, hash and refs; display lines follow the new ranges', async () => {
    const path = join(repo.root, 'src/big.ts');
    const original = [...bigFunction('alpha'), ...bigFunction('beta'), ...bigFunction('gamma')];
    await writeFile(path, original.join('\n'));
    execFileSync('git', ['add', '-A'], { cwd: repo.root, stdio: 'ignore' });
    await scan();
    const before = chunks.find((c) => c.id === 'src/big.ts#beta')!;
    expect(before.isLeaf).toBe(true);
    expect(chunkLineCount(before)).toBe(111);

    const r = saved(await saveQuestions(repo.root, { chunkId: before.id, chunkHash: before.contentHash, questions: [BETA_Q] }, { generatedBy: BY, now: NOW }));
    expect(r.accepted).toHaveLength(1);
    const [q] = await pool(before.id);
    expect(q).toMatchObject({ status: 'ok', chunkHash: before.contentHash, chunkLines: 111, refs: BETA_Q.refs });
    const bytes = await readFile(poolPath(before.id));

    // Insert a new 7-line function (plus a blank line) above beta: its absolute lines shift by 8.
    const inserted = ['export function inserted(y: number): number {', '  const a = y + 1;', '  const b = a * 2;', '  const c = b - 3;', '  const d = c / 4;', '  return d;', '}', ''];
    const betaAt = original.indexOf('export function beta(x: number): number {');
    const moved = [...original.slice(0, betaAt), ...inserted, ...original.slice(betaAt)];
    await writeFile(path, moved.join('\n'));
    await scan();

    const after = chunks.find((c) => c.id === before.id)!;
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.ranges).toEqual([{ ...before.ranges[0]!, start: before.ranges[0]!.start + 8, end: before.ranges[0]!.end + 8 }]);
    expect(chunkLineCount(after)).toBe(q!.chunkLines); // no drift: refs are exact

    // The stored question is untouched: still ok, same hash, refs not rebased, same bytes on disk.
    expect(await readFile(poolPath(before.id))).toEqual(bytes);
    const [q2] = await pool(before.id);
    expect(q2).toEqual(q);

    // Still usable, and the map counts it.
    expect((await okQuestionCounts(repo.root, chunks)).get(before.id)).toBe(1);
    const map = await loadMapTree(repo.root, { env: repo.env, now: NOW });
    const walk = (n: MapNode): MapNode[] => [n, ...n.children.flatMap(walk)];
    expect(walk(map!.root!).find((n) => n.id === before.id)).toMatchObject({ okQuestions: 1, state: { color: 'red' } });

    // Display time: each ref maps to the new absolute line, which holds the same source text.
    for (const ref of q2!.refs) {
      for (const line of [ref.start, ref.end]) {
        const old = toAbsoluteLine(before, line)!;
        const now = toAbsoluteLine(after, line)!;
        expect(now).toEqual({ path: 'src/big.ts', line: before.ranges[0]!.start + line - 1 + 8 });
        expect(moved[now.line - 1]).toBe(original[old.line - 1]);
      }
    }

    // A fresh save against the unchanged hash still works after the move.
    expect(saved(await saveQuestions(repo.root, { chunkId: after.id, chunkHash: after.contentHash, questions: [{ ...BETA_Q, stem: 'Why does beta leave an input of zero unchanged through the loop?' }] }, { generatedBy: BY, now: NOW })).accepted).toHaveLength(1);
  });
});
