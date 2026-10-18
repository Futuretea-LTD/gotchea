import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { FsChunkStore, chunkLineCount, initConfig, runScan, type Rng } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { createServer } from '../src/index.js';

export const NOW = new Date('2026-10-14T12:00:00.000Z');
export const EXPLANATION = 'SEEDED-EXPLANATION: the second guard returns hi.';
/** Sentinels: none of these may ever come back from a tool. */
export const SEED_OPTIONS: QuestionPrivate['options'] = ['SEED-OPT-A', 'SEED-OPT-B', 'SEED-OPT-C', 'SEED-OPT-D'];
export const SEED_STEM = 'What does clamp return for n > hi?';
export const FLAGGED_STEM = 'SEED-FLAGGED-STEM: which guard runs first?';

export const SOURCES: Record<string, string> = {
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
  'src/index.ts': "import { clamp } from './math.js';\n\nexport const limit = (n: number) => clamp(n, 0, 10);\n",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source contains a literal template expression.
  'src/util/strings.ts': 'export function shout(s: string): string {\n  const out = s.toUpperCase();\n  return `${out}!`;\n}\n',
  'py/app.py': 'def greet(name):\n    message = "hello " + name\n    return message\n',
};

/** Three ~110-line functions: over `splitAboveLoc`, so the file is split into symbol leaves. */
const bigFunction = (name: string): string =>
  [`export function ${name}(x: number): number {`, ...Array.from({ length: 108 }, (_, i) => `  x += ${i} * x;`), '  return x;', '}', ''].join('\n');
SOURCES['src/big.ts'] = ['alpha', 'beta', 'gamma'].map(bigFunction).join('\n');

export interface Fixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Chunk id of the leaf that got the seeded question. */
  seededChunkId: string;
  cleanup: () => Promise<void>;
}

export async function createRepo(): Promise<{ root: string; home: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'gotchea-mcp-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-mcp-home-'));
  for (const [path, text] of Object.entries(SOURCES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  return {
    root,
    home,
    env: { ...process.env, GOTCHEA_HOME: home },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Temp git repo, `.gotchea` initialised, scanned, and one leaf seeded with an ok and a flagged question (answer keys on disk). */
export async function createFixture(): Promise<Fixture> {
  const repo = await createRepo();
  await initConfig(repo.root);
  await runScan(repo.root, { env: repo.env });
  const chunks = (await new FsChunkStore(repo.root).load())!.chunks;
  const leaf = chunks.find((c) => c.isLeaf && c.id === 'src/math.ts')!;
  const q: QuestionPrivate = {
    id: 'q1',
    chunkId: leaf.id,
    chunkHash: leaf.contentHash,
    type: 'behavior',
    stem: SEED_STEM,
    options: SEED_OPTIONS,
    correctIndex: 1,
    explanation: EXPLANATION,
    refs: [],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    status: 'ok',
    flagged: false,
    chunkLines: 0,
    promptVersion: 'p1',
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  };
  // Flagged by blind verify: kept on disk but never quizzed, and its stem is not exposed either.
  const flagged: QuestionPrivate = { ...q, id: 'q2', stem: FLAGGED_STEM, flagged: true };
  await new FsQuestionStore(repo.root).save(leaf.id, [q, flagged]);
  return { ...repo, seededChunkId: leaf.id };
}

export async function connect(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { rng?: Rng; elicitation?: 'auto' | 'off'; capabilities?: ClientCapabilities } = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ root, env, now: () => NOW, ...(opts.rng ? { rng: opts.rng } : {}), ...(opts.elicitation ? { elicitation: opts.elicitation } : {}) });
  const client = new Client({ name: 'test', version: '0.0.0' }, opts.capabilities ? { capabilities: opts.capabilities } : undefined);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

export const text = (res: unknown): string =>
  ((res as CallToolResult).content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

/**
 * Overwrites `path` with `source`, rescans and seeds `count` ok questions on that leaf, with exact
 * refs (so reveals carry excerpts). `build(i)` overrides fields per question; options default to four plain ones.
 */
export async function seedLeaf(
  repo: { root: string; env: NodeJS.ProcessEnv },
  path: string,
  source: string,
  build: (i: number) => Partial<QuestionPrivate>,
  count = 3,
): Promise<string> {
  await mkdir(dirname(join(repo.root, path)), { recursive: true });
  await writeFile(join(repo.root, path), source);
  await initConfig(repo.root);
  await runScan(repo.root, { env: repo.env });
  const chunk = (await new FsChunkStore(repo.root).load())!.chunks.find((c) => c.id === path)!;
  const qs: QuestionPrivate[] = Array.from({ length: count }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: chunk.id,
    chunkHash: chunk.contentHash,
    chunkLines: chunkLineCount(chunk),
    type: 'behavior',
    stem: `Stem ${i}`,
    options: ['Option a', 'Option b', 'Option c', 'Option d'],
    correctIndex: (i % 4) as 0 | 1 | 2 | 3,
    explanation: `Because ${i}.`,
    refs: [{ start: 1, end: 2 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
    ...build(i),
  }));
  await new FsQuestionStore(repo.root).save(chunk.id, qs);
  return chunk.id;
}
