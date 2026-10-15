import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.js';
import { GenerateError, runGenerate, type GenerateReport, type RunGenerateOptions } from '../../src/generate/generate.js';
import { buildSystemPrompt, buildUserPrompt } from '../../src/generate/prompt.js';
import { ProviderError, type JsonRequest, type LLMProvider } from '../../src/generate/providers/provider.js';
import { saveQuestions, type SaveResult } from '../../src/generate/save.js';
import { RAW_BATCH_JSON_SCHEMA } from '../../src/generate/schema.js';
import { getGenerationTasks, type GenerationTask } from '../../src/generate/tasks.js';
import type { VerifyOutcome } from '../../src/generate/verify.js';
import { FsChunkStore, initConfig, runScan, type Chunk } from '../../src/index.js';
import { FsQuestionStore, type QuestionPrivate } from '../../src/internal.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const LABEL = 'anthropic:mock';

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

// ---- fixtures for src/math.ts (10 numbered lines) ----
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
const SKEWED = {
  type: 'behavior',
  stem: 'REJECT-STEM-SKEW what happens when lo equals hi in clamp?',
  options: ['REJ-OPT-a-very-much-longer-correct-option-text-here', 'REJ-OPT-x', 'REJ-OPT-y', 'REJ-OPT-z'],
  correctIndex: 0,
  explanation: 'REJ-EXPL L2 and L3 both compare against the same bound.',
  refs: [{ start: 2, end: 3 }],
  difficulty: 2,
};
const SKEWED_AGAIN = {
  ...SKEWED,
  stem: 'REJECT-STEM-SKEW-2 what is returned when hi is below lo in clamp?',
  options: ['REJ-OPT-another-very-much-longer-correct-option-text', 'REJ-OPT-p', 'REJ-OPT-q', 'REJ-OPT-r'],
};
const OVERFLOW_A = {
  type: 'impact',
  stem: 'OVERFLOW-STEM-A what changes if the second guard is deleted from clamp?',
  options: ['OVF-OPT values above hi pass', 'OVF-OPT values below lo pass', 'OVF-OPT nothing changes', 'OVF-OPT it fails to compile'],
  correctIndex: 0,
  explanation: 'OVF-EXPL L3 is the only check against hi; without it larger n reaches L4.',
  refs: [{ start: 3, end: 4 }],
  difficulty: 2,
};
const OVERFLOW_B = {
  ...OVERFLOW_A,
  stem: 'OVERFLOW-STEM-B what does add do differently if L8 multiplies instead of adding?',
  explanation: 'OVF-EXPL-B L8 computes the value that L9 returns.',
  refs: [{ start: 8, end: 9 }],
};

// ---- fixture for src/index.ts (8 numbered lines) ----
const LIMIT_TEN = {
  type: 'behavior',
  stem: 'What value does limit(42) produce?',
  options: ['the value ten', 'the value zero', 'the value 42', 'a thrown error'],
  correctIndex: 0,
  explanation: 'L6 clamps n into the 0 to 10 range and L7 returns it, so the result is ten.',
  refs: [{ start: 6, end: 7 }],
  difficulty: 1,
};

const ALL_FIXTURES = [CLAMP_HI, ADD_SUM, CLAMP_LO, SKEWED, SKEWED_AGAIN, OVERFLOW_A, OVERFLOW_B, LIMIT_TEN];

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

type Step = { value: unknown } | { error: unknown } | { fn: (req: JsonRequest) => unknown };
/** Picks the option text the "model" answers with, or throws. Receives the parsed stem and displayed options. */
type VerifyPicker = (stem: string, options: string[]) => string;

class MockProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model = 'mock';
  readonly requests: JsonRequest[] = [];
  private readonly queue: Step[] = [];

  constructor(private readonly pick?: VerifyPicker) {}

  respond(...values: unknown[]): this {
    for (const value of values) this.queue.push({ value });
    return this;
  }
  fail(error: unknown): this {
    this.queue.push({ error });
    return this;
  }
  respondWith(fn: (req: JsonRequest) => unknown): this {
    this.queue.push({ fn });
    return this;
  }

  get generationRequests(): JsonRequest[] {
    return this.requests.filter((r) => r.schemaName === 'question_batch');
  }
  get verifyRequests(): JsonRequest[] {
    return this.requests.filter((r) => r.schemaName === 'verify_answer');
  }

  async completeJson(req: JsonRequest): Promise<unknown> {
    this.requests.push(req);
    if (req.schemaName === 'verify_answer') {
      if (!this.pick) throw new Error('MockProvider: no verify picker');
      const stem = /^Question: (.*)$/m.exec(req.user)?.[1] ?? '';
      const options = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]!);
      const answer = this.pick(stem, options);
      const answerIndex = options.indexOf(answer);
      if (answerIndex < 0) throw new Error(`MockProvider: option ${answer} not offered`);
      return { answerIndex, confidence: 'high' };
    }
    const step = this.queue.shift();
    // An unqueued request (e.g. the under-delivery retry) fails like a provider would.
    if (!step) throw new ProviderError('http', 'MockProvider: no queued response', { status: 503 });
    if ('error' in step) throw step.error;
    if ('fn' in step) return structuredClone(step.fn(req));
    return structuredClone(step.value);
  }
}

const batch = (...questions: unknown[]) => ({ questions });
/** Answers each generation request by the chunk id in its user prompt. */
const byChunk = (map: Record<string, unknown[]>) => (req: JsonRequest) => {
  const id = /^Chunk: (\S+)/.exec(req.user)?.[1] ?? '';
  const qs = map[id];
  if (!qs) throw new Error(`no fixture for ${id}`);
  return batch(...qs);
};

// ---------------------------------------------------------------------------
// Repo setup
// ---------------------------------------------------------------------------

interface Repo {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'gotchea-rungen-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-rungen-home-'));
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
let index: Chunk;

beforeEach(async () => {
  repo = await createRepo();
  await initConfig(repo.root);
  await runScan(repo.root, { env: repo.env });
  chunks = (await new FsChunkStore(repo.root).load())!.chunks;
  math = chunks.find((c) => c.id === 'src/math.ts')!;
  index = chunks.find((c) => c.id === 'src/index.ts')!;
  expect(math.isLeaf).toBe(true);
  expect(index.isLeaf).toBe(true);
});
afterEach(() => repo.cleanup());

const pool = (chunkId = math.id) => new FsQuestionStore(repo.root).list(chunkId);
const run = (opts: RunGenerateOptions) => runGenerate(repo.root, { now: NOW, ...opts });
const only = (r: GenerateReport) => {
  expect(r.chunks).toHaveLength(1);
  return r.chunks[0]!;
};
const tasksFor = async (opts: Parameters<typeof getGenerationTasks>[1] = {}): Promise<GenerationTask[]> =>
  (await getGenerationTasks(repo.root, opts))!.tasks;

// ---------------------------------------------------------------------------

describe('runGenerate: default selection', () => {
  it('runs chunks in priority order, stamps provider label, chunk hash, refs and lang', async () => {
    const expected = await tasksFor({ lang: 'tr' });
    expect(expected.map((t) => t.chunkId).sort()).toEqual([index.id, math.id].sort());

    const provider = new MockProvider();
    for (let i = 0; i < expected.length; i++) provider.respondWith(byChunk({ [math.id]: [CLAMP_HI, ADD_SUM, CLAMP_LO], [index.id]: [LIMIT_TEN] }));
    const seen: string[] = [];
    const report = await run({ provider, lang: 'tr', onChunk: (c) => seen.push(c.chunkId) });

    expect(report.dryRun).toBe(false);
    expect(report.chunks.map((c) => c.chunkId)).toEqual(expected.map((t) => t.chunkId));
    expect(seen).toEqual(expected.map((t) => t.chunkId));

    const m = report.chunks.find((c) => c.chunkId === math.id)!;
    const ix = report.chunks.find((c) => c.chunkId === index.id)!;
    expect(m).toMatchObject({ requested: 3, saved: 3, flagged: 0, rejected: [], usable: 3, target: 6 });
    expect(m.skipped).toBeUndefined();
    // index under-delivers (1 of 3) without rejections: one retry for the missing 2 (unqueued here, so it fails)
    expect(ix).toMatchObject({ requested: expected.find((t) => t.chunkId === index.id)!.count, saved: 1, flagged: 0, rejected: [], usable: 1 });
    expect(provider.requests).toHaveLength(3);
    const retry = provider.requests[provider.requests.length - 1]!;
    expect(retry.user.startsWith(`Chunk: ${index.id} `)).toBe(true);
    expect(retry.user).toContain('Write 2 questions;');
    expect(retry.user.endsWith('Previous attempt returned 1 of 3 questions.')).toBe(true);

    expect(report.totals).toEqual({
      saved: report.chunks.reduce((s, c) => s + c.saved, 0),
      rejected: report.chunks.reduce((s, c) => s + c.rejected.length, 0),
      flagged: 0,
    });
    expect(report.totals.saved).toBe(4);
    expect(report.verifyErrors).toBe(0);

    const stored = await pool(math.id);
    expect(stored).toHaveLength(3);
    for (const q of stored) {
      expect(q).toMatchObject({
        chunkId: math.id,
        chunkHash: math.contentHash,
        lang: 'tr',
        generatedBy: LABEL,
        flagged: false,
        verifiedBy: null,
        status: 'ok',
        createdAt: NOW.toISOString(),
      });
    }
    expect(stored.find((q) => q.stem === CLAMP_HI.stem)!.refs).toEqual([{ start: 3, end: 3 }]);
    expect(stored.find((q) => q.stem === ADD_SUM.stem)!.refs).toEqual([{ start: 8, end: 9 }]);
    const ixStored = await pool(index.id);
    expect(ixStored).toHaveLength(1);
    expect(ixStored[0]).toMatchObject({ chunkHash: index.contentHash, refs: [{ start: 6, end: 7 }], lang: 'tr', generatedBy: LABEL });
  });

  it('sends the generation request with the fixed schema, effort and prompts', async () => {
    const [task] = await tasksFor({ chunkId: math.id, lang: 'tr' });
    const provider = new MockProvider().respond(batch(CLAMP_HI, ADD_SUM, CLAMP_LO));
    await run({ provider, chunkId: math.id, lang: 'tr' });

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.schemaName).toBe('question_batch');
    expect(req.effort).toBe('medium');
    expect(req.schema).toEqual(RAW_BATCH_JSON_SCHEMA);
    expect(req.system).toBe(buildSystemPrompt());
    expect(req.user).toBe(buildUserPrompt(task!));
    expect(req.user).toContain('language: tr');
  });

  it('respects limit', async () => {
    const expected = await tasksFor();
    const provider = new MockProvider().respondWith(byChunk({ [math.id]: [CLAMP_HI], [index.id]: [LIMIT_TEN] }));
    const report = await run({ provider, limit: 1 });
    expect(report.chunks.map((c) => c.chunkId)).toEqual([expected[0]!.chunkId]);
    expect(report.remaining).toBe(1);
    // One chunk: its request plus the under-delivery retry.
    expect(provider.requests.every((r) => r.user.startsWith(`Chunk: ${expected[0]!.chunkId} `))).toBe(true);
    expect(provider.requests).toHaveLength(2);
  });
});

describe('runGenerate: chunkId option', () => {
  it('restricts the run to that chunk', async () => {
    const provider = new MockProvider().respond(batch(LIMIT_TEN));
    const report = await run({ provider, chunkId: index.id });
    expect(only(report)).toMatchObject({ chunkId: index.id, saved: 1 });
    expect(provider.requests).toHaveLength(2); // + the under-delivery retry
    expect(provider.requests[0]!.user.startsWith(`Chunk: ${index.id} `)).toBe(true);
    expect(await pool(math.id)).toEqual([]);
  });

  it('resolves an alias to the current chunk', async () => {
    const store = new FsChunkStore(repo.root);
    const file = (await store.load())!;
    await store.save({ ...file, chunks: file.chunks.map((c) => (c.id === math.id ? { ...c, aliases: ['src/old-math.ts'] } : c)) });

    const provider = new MockProvider().respond(batch(CLAMP_HI));
    const report = await run({ provider, chunkId: 'src/old-math.ts' });
    expect(only(report)).toMatchObject({ chunkId: math.id, saved: 1 });
    expect((await pool(math.id)).map((q) => q.chunkId)).toEqual([math.id]);
  });

  it("throws GenerateError 'unknown_chunk' for an unknown id, without calling the provider", async () => {
    const provider = new MockProvider();
    const p = run({ provider, chunkId: 'src/nope.ts' });
    await expect(p).rejects.toBeInstanceOf(GenerateError);
    await expect(p).rejects.toMatchObject({ code: 'unknown_chunk' });
    expect(provider.requests).toEqual([]);
  });

  it("throws GenerateError 'not_leaf' for a non-leaf chunk", async () => {
    const mod = chunks.find((c) => c.id === 'src')!;
    expect(mod.isLeaf).toBe(false);
    const provider = new MockProvider();
    await expect(run({ provider, chunkId: mod.id })).rejects.toMatchObject({ name: 'GenerateError', code: 'not_leaf' });
    expect(provider.requests).toEqual([]);
  });

  it("reports a full pool as skipped 'pool_full' with usable/target and makes no provider call", async () => {
    const config = resolveConfig({ questions: { poolMultiplier: 1 } });
    const pre = await saveQuestions(
      repo.root,
      { chunkId: math.id, chunkHash: math.contentHash, questions: [CLAMP_HI, ADD_SUM, CLAMP_LO] },
      { generatedBy: 'host:test', config, now: NOW },
    );
    expect(pre.status === 'saved' && pre.accepted.length).toBe(3);

    const provider = new MockProvider();
    const report = await run({ provider, config, chunkId: math.id });
    expect(only(report)).toEqual({ chunkId: math.id, requested: 0, saved: 0, flagged: 0, rejected: [], skipped: 'pool_full', usable: 3, target: 3 });
    expect(report.totals).toEqual({ saved: 0, rejected: 0, flagged: 0 });
    expect(provider.requests).toEqual([]);
  });
});

describe('runGenerate: dryRun', () => {
  it('calls no provider and reports typePlan and requested', async () => {
    const expected = await tasksFor();
    const provider = new MockProvider();
    const report = await run({ provider, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.chunks).toEqual(
      expected.map((t) => ({ chunkId: t.chunkId, requested: t.count, saved: 0, flagged: 0, rejected: [], typePlan: t.typePlan })),
    );
    expect(provider.requests).toEqual([]);
    expect(await pool(math.id)).toEqual([]);
  });

  it('needs no provider', async () => {
    const report = await run({ dryRun: true, chunkId: math.id });
    expect(only(report)).toMatchObject({ chunkId: math.id, requested: 3, typePlan: expect.any(Array) });
    expect(only(report).typePlan).toHaveLength(3);
  });
});

describe('runGenerate: retry', () => {
  it('retries once for the missing count with rejection codes and accepted stems, and never a third time', async () => {
    const [task] = await tasksFor({ chunkId: math.id });
    expect(task!.count).toBe(3);
    const provider = new MockProvider().respond(batch(CLAMP_HI, SKEWED), batch(SKEWED_AGAIN), batch(ADD_SUM));
    const report = await run({ provider, chunkId: math.id });

    expect(provider.requests).toHaveLength(2);
    const [first, retry] = provider.requests as [JsonRequest, JsonRequest];
    expect(first.user).toBe(buildUserPrompt(task!));
    expect(retry.schemaName).toBe('question_batch');
    expect(retry.system).toBe(buildSystemPrompt());
    expect(retry.user).toMatch(/\n\nPrevious attempt rejected: 1: length_skew\.[^\n]*$/);
    expect(retry.user).toContain('Write 2 questions;');
    const stems = /Existing questions \(do not repeat\):\n([\s\S]*?)\n\n/.exec(retry.user)![1]!;
    expect(stems).toContain(`- ${CLAMP_HI.stem}`);
    // the retry prompt is the task prompt for the missing count, plus the note
    const retryBase = retry.user.slice(0, retry.user.lastIndexOf('\n\nPrevious attempt rejected:'));
    expect(retryBase).toBe(
      buildUserPrompt({ ...task!, count: 2, typePlan: [task!.typePlan[1]!, task!.typePlan[2]!], existingStems: [CLAMP_HI.stem] }),
    );
    // no rejected content is echoed back
    expect(retry.user).not.toMatch(/REJ-OPT|REJECT-STEM/);

    const r = only(report);
    expect(r).toMatchObject({ requested: 3, saved: 1, flagged: 0, usable: 1, target: 6 });
    expect(r.rejected).toEqual([
      { attempt: 1, index: 1, reason: 'length_skew' },
      { attempt: 2, index: 0, reason: 'length_skew' },
    ]);
    expect(report.totals).toEqual({ saved: 1, rejected: 2, flagged: 0 });
    expect((await pool()).map((q) => q.stem)).toEqual([CLAMP_HI.stem]);
  });

  it('adds retry results to the report', async () => {
    const provider = new MockProvider().respond(batch(CLAMP_HI, SKEWED, CLAMP_LO), batch(ADD_SUM));
    const r = only(await run({ provider, chunkId: math.id }));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.user).toContain('Write 1 questions;');
    expect(r).toMatchObject({ saved: 3, usable: 3, rejected: [{ attempt: 1, index: 1, reason: 'length_skew' }] });
    expect((await pool()).map((q) => q.stem).sort()).toEqual([ADD_SUM.stem, CLAMP_HI.stem, CLAMP_LO.stem].sort());
  });
});

describe('runGenerate: over-delivery', () => {
  it("drops items beyond task.count as 'batch_overflow' and does not save them", async () => {
    const provider = new MockProvider().respond(batch(CLAMP_HI, ADD_SUM, CLAMP_LO, OVERFLOW_A, OVERFLOW_B));
    const r = only(await run({ provider, chunkId: math.id }));
    expect(provider.requests).toHaveLength(1);
    expect(r.saved).toBe(3);
    expect(r.rejected).toEqual([
      { attempt: 1, index: 3, reason: 'batch_overflow' },
      { attempt: 1, index: 4, reason: 'batch_overflow' },
    ]);
    const stems = (await pool()).map((q) => q.stem);
    expect(stems).toHaveLength(3);
    expect(stems).not.toContain(OVERFLOW_A.stem);
    expect(stems).not.toContain(OVERFLOW_B.stem);
  });
});

describe('runGenerate: provider errors', () => {
  it("reports a ProviderError on one chunk as skipped 'error' and continues", async () => {
    const order = (await tasksFor()).map((t) => t.chunkId);
    const [firstId, secondId] = order as [string, string];
    const provider = new MockProvider()
      .fail(new ProviderError('http', 'anthropic returned HTTP 529 (overloaded)', { status: 529 }))
      .respondWith(byChunk({ [math.id]: [CLAMP_HI], [index.id]: [LIMIT_TEN] }));
    const report = await run({ provider });

    expect(report.chunks.map((c) => c.chunkId)).toEqual(order);
    expect(report.chunks[0]).toEqual({
      chunkId: firstId,
      requested: expect.any(Number),
      saved: 0,
      flagged: 0,
      rejected: [],
      skipped: 'error',
      error: 'anthropic returned HTTP 529 (overloaded)',
    });
    expect(report.chunks[1]).toMatchObject({ chunkId: secondId, saved: 1 });
    expect(report.chunks[1]!.skipped).toBeUndefined();
    expect(await pool(firstId)).toEqual([]);
    expect(await pool(secondId)).toHaveLength(1);
    expect(report.totals.saved).toBe(1);
  });

  it("rethrows a 'missing_api_key' ProviderError and aborts the run", async () => {
    const provider = new MockProvider()
      .fail(new ProviderError('missing_api_key', 'ANTHROPIC_API_KEY is not set'))
      .respondWith(byChunk({ [math.id]: [CLAMP_HI], [index.id]: [LIMIT_TEN] }));
    const p = run({ provider });
    await expect(p).rejects.toBeInstanceOf(ProviderError);
    await expect(p).rejects.toMatchObject({ code: 'missing_api_key' });
    expect(provider.requests).toHaveLength(1);
    expect(await pool(math.id)).toEqual([]);
    expect(await pool(index.id)).toEqual([]);
  });

  it("rethrows a non-ProviderError (bug) instead of reporting it", async () => {
    const provider = new MockProvider().fail(new TypeError('boom'));
    await expect(run({ provider, chunkId: math.id })).rejects.toThrow('boom');
  });

  it("reports a response that is not a question batch as skipped 'error'", async () => {
    const provider = new MockProvider().respond({ foo: 1 });
    const r = only(await run({ provider, chunkId: math.id }));
    expect(r).toMatchObject({ chunkId: math.id, saved: 0, skipped: 'error', rejected: [] });
    expect(r.error).toMatch(/anthropic:mock returned JSON that is not a question batch/);
    expect(provider.requests).toHaveLength(1);
  });

  it('keeps first-attempt results when the retry fails', async () => {
    const provider = new MockProvider().respond(batch(CLAMP_HI, SKEWED)).fail(new ProviderError('network', 'network failure'));
    const r = only(await run({ provider, chunkId: math.id }));
    expect(provider.requests).toHaveLength(2);
    expect(r.saved).toBe(1);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBe('network failure');
    expect(r.rejected).toEqual([{ attempt: 1, index: 1, reason: 'length_skew' }]);
  });
});

describe('runGenerate: blind verify', () => {
  it('saves a correctly answered question unflagged with verifiedBy, and a wrongly answered one flagged and unusable', async () => {
    // HI answered correctly, ADD_SUM answered with a distractor
    const verifier = new MockProvider((stem) => (stem === CLAMP_HI.stem ? CLAMP_HI.options[0]! : ADD_SUM.options[2]!));
    const provider = new MockProvider().respond(batch(CLAMP_HI, ADD_SUM));
    const report = await run({ provider, verifier, chunkId: math.id });

    expect(provider.requests).toHaveLength(2); // 2 of 3 delivered: one retry (unqueued, fails)
    expect(verifier.verifyRequests).toHaveLength(2);
    expect(verifier.generationRequests).toHaveLength(0);
    const r = only(report);
    expect(r).toMatchObject({ saved: 2, flagged: 1, usable: 1, target: 6, rejected: [] });
    expect(report.totals).toEqual({ saved: 2, rejected: 0, flagged: 1 });
    expect(report.verifyErrors).toBe(0);

    const stored = await pool();
    expect(stored.find((q) => q.stem === CLAMP_HI.stem)).toMatchObject({ flagged: false, verifiedBy: LABEL });
    expect(stored.find((q) => q.stem === ADD_SUM.stem)).toMatchObject({ flagged: true, verifiedBy: LABEL });
  });

  it('marks every question flagged when the verifier always disagrees', async () => {
    const verifier = new MockProvider(() => CLAMP_HI.options[1]!);
    const provider = new MockProvider().respond(batch(CLAMP_HI));
    const r = only(await run({ provider, verifier, chunkId: math.id }));
    expect(r).toMatchObject({ saved: 1, flagged: 1, usable: 0 });
    expect((await pool())[0]).toMatchObject({ flagged: true, verifiedBy: LABEL });
  });

  it('sends a blind verify request without key, explanation, refs or type', async () => {
    const [task] = await tasksFor({ chunkId: math.id });
    const verifier = new MockProvider(() => CLAMP_HI.options[0]!);
    const provider = new MockProvider().respond(batch(CLAMP_HI));
    await run({ provider, verifier, chunkId: math.id });

    const [req] = verifier.verifyRequests as [JsonRequest];
    expect(req.effort).toBe('low');
    expect(req.user).toContain(`Question: ${CLAMP_HI.stem}`);
    expect(req.user).toContain(task!.code);
    const shown = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]);
    expect([...shown].sort()).toEqual([...CLAMP_HI.options].sort());
    for (const text of [req.user, req.system]) {
      expect(text).not.toContain('correctIndex');
      expect(text).not.toContain(CLAMP_HI.explanation);
      expect(text).not.toMatch(/explanation/i);
      expect(text).not.toContain('behavior');
    }
  });

  it('saves unverified and counts verifyErrors when the verifier throws', async () => {
    const verifier = new MockProvider(() => {
      throw new ProviderError('http', 'verifier HTTP 500', { status: 500 });
    });
    const provider = new MockProvider().respond(batch(CLAMP_HI, ADD_SUM));
    const report = await run({ provider, verifier, chunkId: math.id });

    const r = only(report);
    expect(r).toMatchObject({ saved: 2, flagged: 0, usable: 2 });
    expect(report.verifyErrors).toBe(2);
    for (const q of await pool()) expect(q).toMatchObject({ flagged: false, verifiedBy: null });
  });

  it('does not verify rejected or overflow items', async () => {
    const verifier = new MockProvider(() => CLAMP_HI.options[0]!);
    const provider = new MockProvider().respond(batch(CLAMP_HI, SKEWED, ADD_SUM, OVERFLOW_A), batch(CLAMP_LO));
    await run({ provider, verifier, chunkId: math.id });
    const asked = verifier.verifyRequests.map((r) => /^Question: (.*)$/m.exec(r.user)![1]);
    expect(asked).toEqual([CLAMP_HI.stem, ADD_SUM.stem, CLAMP_LO.stem]);
  });
});

describe('runGenerate: report never leaks question content', () => {
  it('contains no stems, options or explanations across retry, overflow, verify and errors', async () => {
    const verifier = new MockProvider((stem, options) => {
      if (stem === ADD_SUM.stem) throw new ProviderError('http', 'verify failed');
      return stem === CLAMP_HI.stem ? CLAMP_HI.options[0]! : options[0]!;
    });
    const provider = new MockProvider()
      .respondWith(
        byChunk({
          [math.id]: [CLAMP_HI, SKEWED, ADD_SUM, OVERFLOW_A, OVERFLOW_B],
          [index.id]: [LIMIT_TEN],
        }),
      )
      .respondWith(byChunk({ [math.id]: [SKEWED_AGAIN, CLAMP_LO], [index.id]: [LIMIT_TEN] }))
      .respondWith(byChunk({ [math.id]: [CLAMP_LO], [index.id]: [LIMIT_TEN] }));
    const report = await run({ provider, verifier });
    const dry = await run({ dryRun: true });

    expect(report.totals.saved).toBeGreaterThan(0);
    expect(report.totals.rejected).toBeGreaterThan(0);
    for (const json of [JSON.stringify(report), JSON.stringify(dry)]) {
      for (const f of ALL_FIXTURES) {
        expect(json).not.toContain(f.stem);
        expect(json).not.toContain(f.explanation);
        for (const o of f.options) expect(json).not.toContain(o);
      }
      expect(json).not.toMatch(/correctIndex|explanation|REJ-|OVF-|OVERFLOW-STEM|REJECT-STEM/);
    }
  });
});

describe('saveQuestions: verify hook', () => {
  it('stamps the hook outcome and mirrors flagged in accepted[]', async () => {
    const seen: QuestionPrivate[] = [];
    const verify = async (q: QuestionPrivate): Promise<VerifyOutcome> => {
      seen.push(q);
      if (q.stem === CLAMP_HI.stem) return { flagged: true, verifiedBy: 'openai:judge' };
      if (q.stem === ADD_SUM.stem) return { flagged: false, verifiedBy: null, error: 'verifier timed out' };
      return { flagged: false, verifiedBy: 'openai:judge' };
    };
    const r: SaveResult = await saveQuestions(
      repo.root,
      { chunkId: math.id, chunkHash: math.contentHash, questions: [CLAMP_HI, SKEWED, ADD_SUM, CLAMP_LO] },
      { generatedBy: 'host:test', now: NOW, verify },
    );
    if (r.status !== 'saved') throw new Error(`expected saved, got ${r.reason}`);

    // only accepted items are verified, with the stamped question
    expect(seen.map((q) => q.stem)).toEqual([CLAMP_HI.stem, ADD_SUM.stem, CLAMP_LO.stem]);
    for (const q of seen) expect(q).toMatchObject({ chunkId: math.id, chunkHash: math.contentHash, flagged: false, verifiedBy: null });

    expect(r.accepted.map((a) => [a.index, a.flagged])).toEqual([
      [0, true],
      [2, false],
      [3, false],
    ]);
    expect(r.accepted.map((a) => a.id)).toEqual(seen.map((q) => q.id));
    expect(r.rejected.map((x) => [x.index, x.reason])).toEqual([[1, 'length_skew']]);
    expect(r.verifyErrors).toEqual(['verifier timed out']);
    expect(r.usableQuestions).toBe(2);

    const stored = await pool();
    const byStem = (s: string) => stored.find((q) => q.stem === s)!;
    expect(byStem(CLAMP_HI.stem)).toMatchObject({ flagged: true, verifiedBy: 'openai:judge', generatedBy: 'host:test' });
    expect(byStem(ADD_SUM.stem)).toMatchObject({ flagged: false, verifiedBy: null });
    expect(byStem(CLAMP_LO.stem)).toMatchObject({ flagged: false, verifiedBy: 'openai:judge' });
    for (const a of r.accepted) expect(stored.find((q) => q.id === a.id)!.flagged).toBe(a.flagged);
  });

  it('defaults to unflagged and unverified without a hook', async () => {
    const r = await saveQuestions(
      repo.root,
      { chunkId: math.id, chunkHash: math.contentHash, questions: [CLAMP_HI] },
      { generatedBy: 'host:test', now: NOW },
    );
    if (r.status !== 'saved') throw new Error('expected saved');
    expect(r.accepted).toEqual([{ index: 0, id: expect.stringMatching(/^q_/), flagged: false }]);
    expect(r.verifyErrors).toEqual([]);
  });
});
