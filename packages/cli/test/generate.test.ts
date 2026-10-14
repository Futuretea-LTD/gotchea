import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, ProviderError, type CreateProvider, type JsonRequest, type LLMProvider } from 'gotchea-core';
import { FsQuestionStore } from 'gotchea-core/internal';
import { allKeys, createSandbox, type Sandbox } from './helpers.js';

let s: Sandbox;

beforeEach(async () => {
  s = await createSandbox();
});

afterEach(async () => {
  await s.cleanup();
});

// Distinct stems (no trigram near-duplicates), same-shape options, a citation valid in any chunk.
const STEMS = [
  'Why does this code guard its input before using it?',
  'What is produced when the collection argument is empty?',
  'Which change would break callers relying on this behaviour?',
  'How are values outside the expected range treated here?',
  'What goes wrong if the loop bound becomes inclusive?',
  'What does the caller observe after a successful call?',
];
const OPTIONS = ['SENTINEL-OPT alpha path', 'SENTINEL-OPT bravo path', 'SENTINEL-OPT charlie path', 'SENTINEL-OPT delta path'];
const EXPLANATION = 'SENTINEL-EXPL: L1 shows why the first option holds and the others do not.';

const question = (i: number) => ({
  type: 'behavior',
  stem: STEMS[i % STEMS.length],
  options: OPTIONS,
  correctIndex: 0,
  explanation: EXPLANATION,
  refs: [{ start: 1, end: 1 }],
  difficulty: 2,
});

class MockProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model = 'mock';
  readonly requests: JsonRequest[] = [];
  /** Next stem; advances so successive batches don't repeat stored stems. */
  #next = 0;

  constructor(private readonly behaviour: { verifyPick?: (options: string[]) => number; fail?: boolean } = {}) {}

  async completeJson(req: JsonRequest): Promise<unknown> {
    this.requests.push(req);
    if (this.behaviour.fail) throw new ProviderError('http', 'mock HTTP 500', { status: 500 });
    if (req.schemaName === 'verify_answer') {
      const options = [...req.user.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2]!);
      return { answerIndex: (this.behaviour.verifyPick ?? ((o) => o.indexOf(OPTIONS[0]!)))(options), confidence: 'high' };
    }
    const count = Number(/Write (\d+) questions/.exec(req.user)![1]);
    return { questions: Array.from({ length: count }, () => question(this.#next++)) };
  }

  /** Chunk ids of generation requests, in order. */
  chunks(): string[] {
    return this.requests.filter((r) => r.schemaName === 'question_batch').map((r) => /^Chunk: (\S+)/.exec(r.user)![1]!);
  }
}

function mockDeps(provider: LLMProvider) {
  const calls: { name: string; model?: string }[] = [];
  const createProvider: CreateProvider = async (name, opts) => {
    calls.push({ name, ...(opts.model !== undefined ? { model: opts.model } : {}) });
    return provider;
  };
  return { calls, deps: { createProvider } };
}

async function scanned(): Promise<void> {
  expect((await s.gotchea(['init'])).code).toBe(0);
  expect((await s.gotchea(['scan'])).code).toBe(0);
}

async function leafIds(): Promise<string[]> {
  const file = await new FsChunkStore(s.root).load();
  return file!.chunks.filter((c) => c.isLeaf).map((c) => c.id);
}

const FORBIDDEN_KEYS = ['correctIndex', 'explanation', 'options', 'stem', 'refs'];
const expectNoAnswerData = (text: string) => {
  expect(text).not.toContain('SENTINEL');
  for (const stem of STEMS) expect(text).not.toContain(stem);
};

describe('gotchea generate', () => {
  it('requires init and a scan', async () => {
    expect((await s.gotchea(['generate'])).stderr).toContain('gotchea init');
    await s.gotchea(['init']);
    const r = await s.gotchea(['generate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('gotchea scan');
  });

  it('fails with exit 2 and the MCP hint when the API key is missing', async () => {
    await scanned();
    const r = await s.gotchea(['generate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set');
    expect(r.stderr).toContain('get_generation_tasks/save_questions');
    const openai = await s.gotchea(['generate', '--provider', 'openai']);
    expect(openai.code).toBe(2);
    expect(openai.stderr).toContain('OPENAI_API_KEY is not set');
  });

  it('reports a missing model and bad flags with exit 2', async () => {
    await scanned();
    const noModel = await s.gotchea(['generate', '--provider', 'openai-compatible']);
    expect(noModel.code).toBe(2);
    expect(noModel.stderr).toContain('No model set for openai-compatible');
    expect((await s.gotchea(['generate', '--provider', 'bogus'])).code).toBe(2);
    expect((await s.gotchea(['generate', '--lang', 'Turkish'])).code).toBe(2);
    expect((await s.gotchea(['generate', '--limit', '0'])).code).toBe(2);
  });

  it('generates in priority order, persists against the current hash and prints counts only', async () => {
    await scanned();
    const mock = new MockProvider();
    const { calls, deps } = mockDeps(mock);
    const r = await s.gotchea(['generate', '--limit', '2'], { deps });
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ name: 'anthropic' }]);
    expect(mock.chunks()).toHaveLength(2);

    const file = (await new FsChunkStore(s.root).load())!;
    const store = new FsQuestionStore(s.root);
    for (const id of mock.chunks()) {
      const chunk = file.chunks.find((c) => c.id === id)!;
      const pool = await store.list(id);
      expect(pool.length).toBeGreaterThan(0);
      for (const q of pool) {
        expect(q).toMatchObject({ chunkHash: chunk.contentHash, generatedBy: 'anthropic:mock', lang: 'en', refs: [{ start: 1, end: 1 }], flagged: false });
      }
      expect(r.stdout).toMatch(new RegExp(`✓ ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  \\d+ saved · 0 rejected · 0 flagged`));
    }
    expect(r.stdout).toMatch(/Total: \d+ saved · 0 rejected · 0 flagged/);
    expectNoAnswerData(r.stdout + r.stderr);
  });

  it('--chunk restricts to one leaf, --lang is stamped, a full pool is reported', async () => {
    await scanned();
    const target = 'src/math.ts';
    expect(await leafIds()).toContain(target);
    const mock = new MockProvider();
    const { deps } = mockDeps(mock);
    const r = await s.gotchea(['generate', '--chunk', target, '--lang', 'tr'], { deps });
    expect(r.code).toBe(0);
    expect(mock.chunks()).toEqual([target]);
    expect(mock.requests[0]!.user).toContain('language: tr.');
    const pool = await new FsQuestionStore(s.root).list(target);
    expect(pool.every((q) => q.lang === 'tr')).toBe(true);

    // Fill the rest of the pool, then the chunk is full.
    await s.gotchea(['generate', '--chunk', target], { deps });
    const full = await s.gotchea(['generate', '--chunk', target], { deps });
    expect(full.code).toBe(0);
    expect(full.stdout).toMatch(/pool full \(\d+\/\d+\)/);
  });

  it('--chunk rejects unknown and non-leaf ids', async () => {
    await scanned();
    const { deps } = mockDeps(new MockProvider());
    const unknown = await s.gotchea(['generate', '--chunk', 'src/nope.ts#x'], { deps });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown chunk');
    const notLeaf = await s.gotchea(['generate', '--chunk', 'src'], { deps });
    expect(notLeaf.code).toBe(1);
    expect(notLeaf.stderr).toContain('not a leaf');
  });

  it('--dry-run builds no provider and saves nothing', async () => {
    await scanned();
    const mock = new MockProvider();
    const { calls, deps } = mockDeps(mock);
    const r = await s.gotchea(['generate', '--dry-run', '--limit', '3'], { deps });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(r.stdout).toContain('Dry run');
    expect(r.stdout.match(/^· /gm)).toHaveLength(3);
    for (const id of await leafIds()) expect(await new FsQuestionStore(s.root).list(id)).toEqual([]);
  });

  it('--json carries ids, counts and reason codes only', async () => {
    await scanned();
    const { deps } = mockDeps(new MockProvider());
    const r = await s.gotchea(['generate', '--json', '--limit', '2'], { deps });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[0]).toMatchObject({ chunkId: expect.any(String), requested: expect.any(Number), saved: expect.any(Number), flagged: 0, rejected: [] });
    expect(out.totals.saved).toBe(out.chunks[0].saved + out.chunks[1].saved);
    const keys = allKeys(out);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
    expectNoAnswerData(r.stdout);
  });

  it('--verify flags questions the blind verifier answers differently', async () => {
    await scanned();
    const mock = new MockProvider({ verifyPick: (o) => o.indexOf(OPTIONS[1]!) });
    const { deps } = mockDeps(mock);
    const r = await s.gotchea(['generate', '--verify', '--limit', '1', '--json'], { deps });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.chunks[0].flagged).toBe(out.chunks[0].saved);
    expect(out.chunks[0].saved).toBeGreaterThan(0);
    const verifyReqs = mock.requests.filter((q) => q.schemaName === 'verify_answer');
    expect(verifyReqs).toHaveLength(out.chunks[0].saved);
    for (const q of verifyReqs) expect(q.user).not.toContain('SENTINEL-EXPL');
    const pool = await new FsQuestionStore(s.root).list(out.chunks[0].chunkId);
    expect(pool.every((q) => q.flagged && q.verifiedBy === 'anthropic:mock')).toBe(true);
  });

  it('reports provider errors per chunk and exits 1 when every chunk failed', async () => {
    await scanned();
    const { deps } = mockDeps(new MockProvider({ fail: true }));
    const r = await s.gotchea(['generate', '--limit', '2'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout.match(/✗ .*error: mock HTTP 500/g)).toHaveLength(2);
    expect(r.stderr).toContain('every chunk failed');
  });
});
