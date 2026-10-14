import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, chunkLineCount, computeRepoId, seededRng } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import { ScriptedAnswerSource } from '../src/quiz/scripted-source.js';
import { createSandbox, question, type Sandbox } from './helpers.js';

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
    for (const q of src.asked) expect(Object.keys(q).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total']);
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

  it('validates --count and --lang', async () => {
    const deps = { answerSource: new ScriptedAnswerSource([]) };
    expect((await s.gotchea(['quiz', '--count', '0'], { deps })).code).toBe(2);
    expect((await s.gotchea(['quiz', '--lang', 'x!'], { deps })).code).toBe(2);
  });
});
