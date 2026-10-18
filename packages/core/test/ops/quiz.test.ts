// Code previews attached by the quiz engine: shown only while the working tree still matches the
// scanned chunk, never for a path outside the repo, and switchable off per session.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { chunkLineCount } from '../../src/generate/chunk-code.js';
import { SourceReader } from '../../src/generate/source.js';
import type { Chunk } from '../../src/model/chunk.js';
import type { QuestionPrivate } from '../../src/model/question.js';
import { type QuizOpsDeps, type StartQuizInput, startQuiz, submitAnswer } from '../../src/ops/quiz.js';
import { runScan } from '../../src/ops/scan.js';
import { seededRng } from '../../src/quiz/rng.js';
import { QuizSessions } from '../../src/quiz/session.js';
import { assertPublicView } from '../../src/quiz/views.js';
import { FsChunkStore } from '../../src/store/chunk-store.js';
import { FsQuestionStore } from '../../src/store/question-store.js';
import { computeRepoId } from '../../src/store/repo-id.js';
import { FsSessionStore, InMemorySessionStore } from '../../src/store/session-store.js';
import type { SessionStore } from '../../src/store/types.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const config = defaultConfig();
const MATH = 'src/math.ts';
// Mentions `correctIndex` and `explanation` on purpose: source may, the key scan must not care.
const MATH_SRC = [
  'export function clamp(n: number, lo: number, hi: number): number {',
  '  const explanation = "correctIndex";',
  '  if (n < lo) return lo;',
  '  if (n > hi) return hi;',
  '  return n;',
  '}',
  '',
].join('\n');
const LONG = 'src/long.ts';
const LONG_SRC = ['export function long(x: number): number {', ...Array.from({ length: 68 }, (_, i) => `  x += ${i};`), '  return x;', '}', ''].join('\n');

let root: string;
let home: string;
let outside: string;
let env: NodeJS.ProcessEnv;

async function write(path: string, text: string, base = root): Promise<void> {
  await mkdir(dirname(join(base, path)), { recursive: true });
  await writeFile(join(base, path), text);
}

const leafOf = async (id: string): Promise<Chunk> => (await new FsChunkStore(root).load())!.chunks.find((c) => c.id === id)!;

async function seed(chunk: Chunk): Promise<void> {
  const qs: QuestionPrivate[] = Array.from({ length: 6 }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: chunk.id,
    chunkHash: chunk.contentHash,
    chunkLines: chunkLineCount(chunk),
    type: 'behavior',
    stem: `STEM-${i}?`,
    options: [`o${i}-correct`, `o${i}-b`, `o${i}-c`, `o${i}-d`],
    correctIndex: 0,
    explanation: `EXPL-${i}`,
    refs: [{ start: 1, end: 2 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    promptVersion: 'p1',
    status: 'ok',
    flagged: false,
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(root).save(chunk.id, qs);
}

const deps = (cfg = config, store: SessionStore = new InMemorySessionStore()): QuizOpsDeps => {
  const rng = seededRng(7);
  return { sessions: QuizSessions.fromConfig(store, cfg.quiz, { now: () => NOW, rng }), origin: 'cli', config: cfg, env, now: () => NOW, rng };
};
const noCode = { ...config, quiz: { ...config.quiz, showCode: false } };

async function answerFirst(res: Awaited<ReturnType<typeof start>>, d: QuizOpsDeps, includeCode?: boolean) {
  const answered = await submitAnswer(root, { sessionId: res.session.id, questionId: res.question.questionId, displayIndex: 0, ...(includeCode !== undefined && { includeCode }) }, d);
  if (answered.status !== 'answered') throw new Error(answered.status);
  return answered;
}

async function start(input: StartQuizInput, d = deps()) {
  const res = await startQuiz(root, { count: 3, ...input }, d);
  if (res.status === 'refused') throw new Error(`${res.reason}: ${res.message}`);
  assertPublicView(res.question);
  return res;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gotchea-quiz-code-'));
  home = await mkdtemp(join(tmpdir(), 'gotchea-quiz-home-'));
  outside = await mkdtemp(join(tmpdir(), 'gotchea-quiz-outside-'));
  env = { ...process.env, GOTCHEA_HOME: home };
  await write(MATH, MATH_SRC);
  await write(LONG, LONG_SRC);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  await runScan(root, { env, config });
  await seed(await leafOf(MATH));
});

afterEach(async () => {
  for (const dir of [root, home, outside]) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('quiz code preview', () => {
  it('attaches the chunk source when the hash matches, on the first and the next question', async () => {
    const d = deps();
    const res = await start({ chunkId: MATH }, d);
    const lines = MATH_SRC.split('\n').slice(0, 6);
    expect(res.question.code).toEqual({ path: MATH, startLine: 1, endLine: 6, language: 'typescript', text: lines.join('\n') });

    const answered = await submitAnswer(root, { sessionId: res.session.id, questionId: res.question.questionId, displayIndex: 0 }, d);
    if (answered.status !== 'answered') throw new Error(answered.status);
    expect(answered.next.code).toEqual(res.question.code);
  });

  it('truncates a chunk longer than 60 lines', async () => {
    const leaf = await leafOf(LONG);
    await seed(leaf);
    const { question } = await start({ chunkId: LONG });
    expect(chunkLineCount(leaf)).toBe(71);
    expect(question.code).toMatchObject({ path: LONG, startLine: 1, endLine: 60, truncated: true });
    expect(question.code!.text.split('\n')).toHaveLength(60);
  });

  it('omits the code when the working tree no longer matches the scanned hash', async () => {
    await write(MATH, MATH_SRC.replace('return n;', 'return n + 1;'));
    expect((await start({ chunkId: MATH })).question).not.toHaveProperty('code');
  });

  it('omits the code when the file is missing', async () => {
    await unlink(join(root, MATH));
    expect((await start({ chunkId: MATH })).question).not.toHaveProperty('code');
  });

  it('omits the code for a path that escapes the repo root', async () => {
    // A tampered chunks.json pointing at an identical file next to the repo.
    const escaped = `../${basename(outside)}/math.ts`;
    await write('math.ts', MATH_SRC, outside);
    const store = new FsChunkStore(root);
    const file = (await store.load())!;
    const leaf = file.chunks.find((c) => c.id === MATH)!;
    const forged: Chunk = { ...leaf, id: escaped, ranges: leaf.ranges.map((r) => ({ ...r, path: escaped })) };
    await store.save({ ...file, chunks: [...file.chunks, forged].sort((a, b) => (a.id < b.id ? -1 : 1)) });
    await seed(forged);
    expect((await start({ chunkId: escaped })).question).not.toHaveProperty('code');
  });

  it('omits the code for a path inside .gotchea/, where the answer files live', async () => {
    // A tampered chunks.json pointing into .gotchea/: the fallback chunker accepts any file and the
    // hash matches, so only the path check stands between the answer key and a pre-answer view.
    const leak = '.gotchea/questions/leak.ts';
    await write(leak, MATH_SRC);
    const store = new FsChunkStore(root);
    const file = (await store.load())!;
    const leaf = file.chunks.find((c) => c.id === MATH)!;
    const forged: Chunk = { ...leaf, id: leak, ranges: leaf.ranges.map((r) => ({ ...r, path: leak })) };
    expect(await new SourceReader(root, config).currentHash(forged)).toBe(leaf.contentHash);
    await store.save({ ...file, chunks: [...file.chunks, forged].sort((a, b) => (a.id < b.id ? -1 : 1)) });
    await seed(forged);
    expect((await start({ chunkId: leak })).question).not.toHaveProperty('code');
  });

  it.each([
    '.GotCheA/questions/leak.ts',
    './.gotchea/questions/leak.ts',
    'foo/../.gotchea/questions/leak.ts',
    '../outside.ts',
    '/absolute.ts',
    'C:/absolute.ts',
  ])('rejects unsafe preview path %s before reading source', async (path) => {
    const store = new FsChunkStore(root);
    const file = (await store.load())!;
    const leaf = file.chunks.find((c) => c.id === MATH)!;
    if (path.toLowerCase().includes('.gotchea/')) await write(path, MATH_SRC);
    const forged: Chunk = { ...leaf, ranges: leaf.ranges.map((r) => ({ ...r, path })) };
    await store.save({ ...file, chunks: file.chunks.map((c) => c.id === MATH ? forged : c) });
    // Even an otherwise hash-matching chunk must be stopped by containment, before source I/O.
    const hash = vi.spyOn(SourceReader.prototype, 'currentHash').mockResolvedValue(leaf.contentHash);
    try {
      expect((await start({ chunkId: MATH })).question).not.toHaveProperty('code');
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it('omits the code for a symlink that resolves into .gotchea/', async () => {
    await write('.gotchea/questions/leak.ts', MATH_SRC);
    await unlink(join(root, MATH));
    await symlink(join(root, '.gotchea/questions/leak.ts'), join(root, MATH));
    expect((await start({ chunkId: MATH })).question).not.toHaveProperty('code');
  });

  it('omits a preview the public schema would reject instead of failing the quiz', async () => {
    // No parser for .txt and an empty scanned lang: the preview would have an empty `language`.
    const notes = 'notes.txt';
    await write(notes, 'plain notes\nsecond line\n');
    const reader = new SourceReader(root, config);
    const draft = await reader.draft(notes);
    const store = new FsChunkStore(root);
    const file = (await store.load())!;
    const leaf = file.chunks.find((c) => c.id === MATH)!;
    const forged: Chunk = { ...leaf, id: notes, lang: '', ranges: draft.ranges, contentHash: '' };
    forged.contentHash = (await reader.currentHash(forged))!;
    await store.save({ ...file, chunks: [...file.chunks, forged].sort((a, b) => (a.id < b.id ? -1 : 1)) });
    await seed(forged);
    expect((await start({ chunkId: notes })).question).not.toHaveProperty('code');
  });

  it('omits the code for a symlink that resolves outside the repo', async () => {
    await write('math.ts', MATH_SRC, outside);
    await unlink(join(root, MATH));
    await symlink(join(outside, 'math.ts'), join(root, MATH));
    expect((await start({ chunkId: MATH })).question).not.toHaveProperty('code');
  });

  it('replaces terminal escapes and CR in the previewed source with visible stand-ins', async () => {
    // An OSC 8 hyperlink and a CRLF line: raw, they would plant a link or rewrite the terminal line.
    const evil = 'src/evil.ts';
    const src = ['export function evil(): string {', '  return "\x1b]8;;http://evil\x07click\x1b]8;;\x07";\r', '}', ''].join('\n');
    await write(evil, src);
    await runScan(root, { env, config });
    await seed(await leafOf(evil));
    const { code } = (await start({ chunkId: evil })).question;
    expect(code).toMatchObject({ path: evil, startLine: 1, endLine: 3 });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no raw ESC, BEL or CR
    expect(code!.text).not.toMatch(/[\x1b\x07\r]/);
    expect(code!.text).toContain('␛]8;;http://evil␇click');
    expect(code!.text.split('\n')).toEqual(['export function evil(): string {', '  return "␛]8;;http://evil␇click␛]8;;␇";', '}']);
  });

  it('omits the code when includeCode is false', async () => {
    const d = deps();
    const res = await start({ chunkId: MATH, includeCode: false }, d);
    expect(res.question).not.toHaveProperty('code');
    const answered = await submitAnswer(root, { sessionId: res.session.id, questionId: res.question.questionId, displayIndex: 0, includeCode: false }, d);
    if (answered.status !== 'answered') throw new Error(answered.status);
    expect(answered.next).not.toHaveProperty('code');
  });
});

describe('quiz.showCode', () => {
  it('quiz.showCode: false omits the code on the first and the next question', async () => {
    const d = deps(noCode);
    const res = await start({ chunkId: MATH }, d);
    expect(res.question).not.toHaveProperty('code');
    expect((await answerFirst(res, d)).next).not.toHaveProperty('code');
  });

  it('an explicit includeCode: true overrides quiz.showCode: false, and the session remembers it', async () => {
    const d = deps(noCode);
    const res = await start({ chunkId: MATH, includeCode: true }, d);
    expect(res.question.code).toMatchObject({ path: MATH });
    expect((await answerFirst(res, d)).next.code).toMatchObject({ path: MATH });
  });

  it('an explicit includeCode: false overrides quiz.showCode: true, and the session remembers it', async () => {
    const d = deps();
    const res = await start({ chunkId: MATH, includeCode: false }, d);
    expect(res.question).not.toHaveProperty('code');
    expect((await answerFirst(res, d)).next).not.toHaveProperty('code');
  });

  it('on resume an explicit includeCode wins for that response without changing the stored choice', async () => {
    const d = deps(noCode);
    const res = await start({ chunkId: MATH }, d);
    await answerFirst(res, d);
    const resumed = await start({ chunkId: MATH, includeCode: true }, d);
    expect(resumed.status).toBe('resumed');
    expect(resumed.question.code).toMatchObject({ path: MATH });
    expect((await d.sessions.get(res.session.id))!.showCode).toBe(false);
    expect((await answerFirst(resumed, d)).next).not.toHaveProperty('code');
  });

  it('a 0.1.x session file without showCode shows the code, whatever the config says', async () => {
    const leaf = await leafOf(MATH);
    const store = new FsSessionStore(await computeRepoId(root), env);
    const id = 'qs_0123456789abcdef';
    const at = NOW.toISOString();
    const qids = ['q_000000000001', 'q_000000000002', 'q_000000000003'];
    // Written by hand, field for field, as 0.1.x did: no `showCode` key.
    const legacy = {
      version: 1,
      id,
      origin: 'cli',
      chunkId: MATH,
      chunkHash: leaf.contentHash,
      lang: 'en',
      questionIds: qids,
      permutations: Object.fromEntries(qids.map((q) => [q, [0, 1, 2, 3]])),
      answers: {},
      status: 'active',
      startedAt: at,
      lastActivityAt: at,
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    };
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.pathFor(id), JSON.stringify(legacy));

    const d = deps(noCode, store);
    expect(await d.sessions.get(id)).not.toHaveProperty('showCode');
    const answered = await submitAnswer(root, { sessionId: id, questionId: qids[0]!, displayIndex: 0 }, d);
    if (answered.status !== 'answered') throw new Error(answered.status);
    expect(answered.next.code).toMatchObject({ path: MATH });
  });
});
