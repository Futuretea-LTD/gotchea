import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_PREVIEW_MAX_LINES,
  FORBIDDEN_KEYS,
  FsChunkStore,
  FsProgressStore,
  assertPublicView,
  chunkLineCount,
  computeRepoId,
  seededRng,
} from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { ScriptedAnswerSource } from '../src/quiz/scripted-source.js';
import { FIXTURE, allKeys, createSandbox, question, type Sandbox } from './helpers.js';

let s: Sandbox;
const LEAF = 'src/math.ts';

beforeEach(async () => {
  s = await createSandbox();
  await s.gotchea(['init']);
  await s.gotchea(['scan']);
});
afterEach(() => s.cleanup());

async function seed(n = 3): Promise<void> {
  const leaf = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === LEAF)!;
  const qs: QuestionPrivate[] = Array.from({ length: n }, (_, i) => ({
    ...question(leaf.id, leaf.contentHash),
    id: `q_${String(i + 1).padStart(12, '0')}`,
    stem: `CLI-STEM-${i + 1}?`,
    options: [`w${i}-a`, `w${i}-correct`, `w${i}-b`, `w${i}-c`],
    correctIndex: 1,
    explanation: `CLI-EXPLANATION-${i + 1}`,
    refs: [{ start: 2, end: 2 }],
    chunkLines: chunkLineCount(leaf),
  }));
  await new FsQuestionStore(s.root).save(leaf.id, qs);
}

const right = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => o.text.endsWith('-correct'))!.index as 0 | 1 | 2 | 3;

describe('gotchea quiz', () => {
  it('needs an interactive terminal without an answer source', async () => {
    const r = await s.gotchea(['quiz']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('interactive terminal');
  });

  it('refuses when no chunk has questions', async () => {
    const r = await s.gotchea(['quiz'], { deps: { answerSource: new ScriptedAnswerSource([]) } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no_quizzable_chunk');
  });

  it('shows each result, then the colour and heatmap, and scores the pass', async () => {
    await seed();
    const src = new ScriptedAnswerSource([right, right, right]);
    const r = await s.gotchea([ 'quiz', LEAF], { deps: { answerSource: src, rng: seededRng(2) } });
    expect(r.code).toBe(0);
    expect(src.asked).toHaveLength(3);
    for (const q of src.asked) expect(Object.keys(q).sort()).toEqual(['code', 'options', 'position', 'questionId', 'stem', 'total']);
    expect(r.stdout.match(/✅ Correct\./g)).toHaveLength(3);
    expect(r.stdout).toContain('Explanation: CLI-EXPLANATION-');
    expect(r.stdout).toContain('Look at: src/math.ts');
    expect(r.stdout).toMatch(/Quiz complete: 3\/3 correct .* PASSED/);
    expect(r.stdout).toContain('Heatmap (src/math.ts)');
    expect(r.stdout).toContain('[G 100%]'); // colours off: letters carry the state
    const repoId = await computeRepoId(s.root);
    expect((await new FsProgressStore(repoId, s.env).load()).chunks[LEAF]!.history).toHaveLength(1);
  });

  it('renders an ANSI heatmap with colours on, and a wrong answer reveals the key', async () => {
    await seed();
    const wrong = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => !o.text.endsWith('-correct'))!.index as 0 | 1 | 2 | 3;
    const r = await s.gotchea(['quiz', LEAF], { color: true, deps: { answerSource: new ScriptedAnswerSource([wrong, right, right]), rng: seededRng(4) } });
    expect(r.stdout).toContain('❌ Incorrect');
    expect(r.stdout).toMatch(/Correct answer: [A-D]\) w\d-correct/);
    expect(r.stdout).toContain('NOT PASSED');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
    expect(r.stdout).toMatch(/\u001b\[31m●/);
  });

  it('quitting abandons the quiz without scoring, and --new skips resume', async () => {
    await seed();
    const r = await s.gotchea(['quiz', LEAF], { deps: { answerSource: new ScriptedAnswerSource([right, 'quit']), rng: seededRng(6) } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Quiz abandoned, nothing was scored.');
    const repoId = await computeRepoId(s.root);
    expect((await new FsProgressStore(repoId, s.env).load()).chunks[LEAF]).toBeUndefined();
  });

  it('offers to resume an interrupted quiz', async () => {
    await seed();
    const deps = (src: ScriptedAnswerSource) => ({ answerSource: src, rng: seededRng(8) });
    // Interrupt: the script throws after one answer (no quit), leaving the session active on disk.
    await s.gotchea(['quiz', LEAF], { deps: deps(new ScriptedAnswerSource([right])) });
    const src = new ScriptedAnswerSource([right, right], [true]);
    const r = await s.gotchea(['quiz', LEAF], { deps: deps(src) });
    expect(src.confirms[0]).toMatch(/Resume your unfinished quiz.*1\/3 answered/);
    expect(r.stdout).toContain('Resumed');
    expect(r.stdout).toMatch(/Quiz complete: 3\/3/);
  });

  describe('code preview', () => {
    const MATH = readFileSync(join(FIXTURE, LEAF), 'utf8').replace(/\n$/, '').split('\n');

    it('prints the numbered source between the header and each stem, with no answer key in it', async () => {
      await seed();
      const src = new ScriptedAnswerSource([right, right, right]);
      const r = await s.gotchea(['quiz', LEAF], { deps: { answerSource: src, rng: seededRng(2) } });
      expect(r.code).toBe(0);
      const width = String(MATH.length).length;
      const block = [`${LEAF}:1-${MATH.length} (typescript)`, ...MATH.map((l, i) => (l === '' ? `${String(i + 1).padStart(width)} │` : `${String(i + 1).padStart(width)} │ ${l}`))];
      expect(r.stdout).toContain(`Question 1 of 3\n${block.join('\n')}\n`);
      expect(r.stdout.split(block[0]!)).toHaveLength(4);
      expect(r.stdout).not.toContain('(truncated)');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
      expect(r.stdout).not.toMatch(/\u001b\[/);
      for (const q of src.asked) {
        expect(q.code).toEqual({ path: LEAF, startLine: 1, endLine: MATH.length, language: 'typescript', text: MATH.join('\n') });
        expect(() => assertPublicView(q)).not.toThrow();
        for (const k of FORBIDDEN_KEYS) expect(allKeys(q).has(k), k).toBe(false);
      }
    });

    it('marks a chunk longer than the preview as truncated', async () => {
      const long = Array.from({ length: CODE_PREVIEW_MAX_LINES + 15 }, (_, i) => `export const v${i} = ${i};`);
      await writeFile(join(s.root, 'src', 'math.ts'), `${long.join('\n')}\n`);
      expect((await s.gotchea(['scan'])).code).toBe(0);
      // A longer chunk wants more questions before it is quizzable.
      await seed(10);
      const src = new ScriptedAnswerSource(['quit']);
      const r = await s.gotchea(['quiz', LEAF], { deps: { answerSource: src, rng: seededRng(2) } });
      expect(r.code, r.stderr).toBe(0);
      expect(src.asked[0]!.code).toMatchObject({ startLine: 1, endLine: CODE_PREVIEW_MAX_LINES, truncated: true });
      expect(r.stdout).toContain(`${LEAF}:1-${CODE_PREVIEW_MAX_LINES} (typescript)`);
      expect(r.stdout).toContain(`${CODE_PREVIEW_MAX_LINES} │ ${long[CODE_PREVIEW_MAX_LINES - 1]}\n   │ … (truncated)\n`);
      expect(r.stdout).not.toContain(long[CODE_PREVIEW_MAX_LINES]!);
    });

    it('--no-code turns the preview off for the whole session', async () => {
      await seed();
      const src = new ScriptedAnswerSource([right, right, right]);
      const r = await s.gotchea(['quiz', LEAF, '--no-code'], { deps: { answerSource: src, rng: seededRng(2) } });
      expect(r.code).toBe(0);
      expect(src.asked).toHaveLength(3);
      for (const q of src.asked) expect(q.code).toBeUndefined();
      expect(r.stdout).not.toContain(`${LEAF}:1-`);
      expect(r.stdout).not.toContain('│ export function clamp');
      expect(r.stdout).toContain('Question 1 of 3\n');
    });

    it('--no-code on a resumed quiz hides the preview on every remaining question', async () => {
      await seed();
      const deps = (src: ScriptedAnswerSource) => ({ answerSource: src, rng: seededRng(8) });
      // Started with the preview on (config default), interrupted after one answer.
      await s.gotchea(['quiz', LEAF], { deps: deps(new ScriptedAnswerSource([right])) });
      const src = new ScriptedAnswerSource([right, right], [true]);
      const r = await s.gotchea(['quiz', LEAF, '--no-code'], { deps: deps(src) });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('Resumed');
      expect(src.asked).toHaveLength(2);
      for (const q of src.asked) expect(q.code).toBeUndefined();
      expect(r.stdout).not.toContain(`${LEAF}:1-`);
    });

    async function hideCodeInConfig(): Promise<void> {
      const path = join(s.root, '.gotchea', 'config.json');
      const config = JSON.parse(await readFile(path, 'utf8')) as { quiz?: Record<string, unknown> };
      await writeFile(path, JSON.stringify({ ...config, quiz: { ...config.quiz, showCode: false } }));
    }

    it('quiz.showCode: false hides the preview on the first and every next question', async () => {
      await hideCodeInConfig();
      await seed();
      const src = new ScriptedAnswerSource([right, right, right]);
      const r = await s.gotchea(['quiz', LEAF], { deps: { answerSource: src, rng: seededRng(2) } });
      expect(r.code, r.stderr).toBe(0);
      expect(src.asked).toHaveLength(3);
      for (const q of src.asked) expect(q.code).toBeUndefined();
      expect(r.stdout).not.toContain(`${LEAF}:1-`);
    });

    it('--code shows the preview on every question despite quiz.showCode: false', async () => {
      await hideCodeInConfig();
      await seed();
      const src = new ScriptedAnswerSource([right, right, right]);
      const r = await s.gotchea(['quiz', LEAF, '--code'], { deps: { answerSource: src, rng: seededRng(2) } });
      expect(r.code, r.stderr).toBe(0);
      expect(src.asked).toHaveLength(3);
      for (const q of src.asked) expect(q.code?.path).toBe(LEAF);
      expect(r.stdout.split(`${LEAF}:1-${MATH.length} (typescript)`)).toHaveLength(4);
    });

    it('highlights with colours on, and NO_COLOR keeps it plain', async () => {
      await seed();
      const colored = await s.gotchea(['quiz', LEAF], { color: true, deps: { answerSource: new ScriptedAnswerSource(['quit']), rng: seededRng(2) } });
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
      expect(colored.stdout).toMatch(/\u001b\[35mexport\u001b\[39m \u001b\[35mfunction\u001b\[39m clamp/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
      expect(colored.stdout).toMatch(/\u001b\[2m\/\*\* Clamps `n` into \[lo, hi\]\. \*\/\u001b\[22m/);

      const plain = await s.gotchea(['quiz', LEAF, '--new'], { color: true, env: { NO_COLOR: '1' }, deps: { answerSource: new ScriptedAnswerSource(['quit']), rng: seededRng(2) } });
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain(' 2 │ export function clamp(n: number, lo: number, hi: number): number {\n');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
      expect(plain.stdout).not.toMatch(/\u001b\[/);
    });
  });

  it('prints control characters in stored question text as visible stand-ins, without changing the store', async () => {
    const leaf = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === LEAF)!;
    const evil = '\u001b]0;pwn\u0007';
    const qs: QuestionPrivate[] = Array.from({ length: 3 }, (_, i) => ({
      ...question(leaf.id, leaf.contentHash),
      id: `q_${String(i + 1).padStart(12, '0')}`,
      stem: `STEM-${i + 1} ${evil}?`,
      options: [`w${i}-a`, `w${i}-correct ${evil}`, `w${i}-b`, `w${i}-c`],
      correctIndex: 1,
      explanation: `EXPLANATION ${evil}`,
      refs: [{ start: 2, end: 2 }],
      chunkLines: chunkLineCount(leaf),
    }));
    await new FsQuestionStore(s.root).save(leaf.id, qs);
    const wrong = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => o.text.endsWith('-a'))!.index as 0 | 1 | 2 | 3;
    const correct = (q: { options: { index: number; text: string }[] }) => q.options.find((o) => o.text.includes('-correct'))!.index as 0 | 1 | 2 | 3;
    const src = new ScriptedAnswerSource([wrong, correct, correct]);
    const r = await s.gotchea(['quiz', LEAF], { deps: { answerSource: src, rng: seededRng(2) } });
    expect(r.code, r.stderr).toBe(0);
    // The answer source prints what it is given; the reveal prints the correct option and explanation.
    for (const q of src.asked) {
      expect(q.stem).toContain('␛]0;pwn␇');
      for (const o of q.options) for (const ch of ['\u001b', '\u0007']) expect(o.text).not.toContain(ch);
    }
    expect(r.stdout).toContain('Correct answer: ');
    expect(r.stdout).toContain('-correct ␛]0;pwn␇');
    expect(r.stdout).toContain('Explanation: EXPLANATION ␛]0;pwn␇');
    for (const ch of ['\u001b', '\u0007']) expect(r.stdout + r.stderr).not.toContain(ch);
    expect((await new FsQuestionStore(s.root).list(leaf.id))[0]!.stem).toContain(evil);
  });

  it('validates --count and --lang', async () => {
    const deps = { answerSource: new ScriptedAnswerSource([]) };
    expect((await s.gotchea(['quiz', '--count', '0'], { deps })).code).toBe(2);
    expect((await s.gotchea(['quiz', '--lang', 'x!'], { deps })).code).toBe(2);
  });
});
