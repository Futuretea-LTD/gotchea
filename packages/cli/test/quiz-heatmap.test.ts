// `gotchea quiz` with a scripted AnswerSource: nothing answer-bearing before the answer (probe at
// every ask), and the ANSI heatmap printed afterwards matches the colour function applied to the
// real retrievability and `gotchea map --json`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsChunkStore, FsProgressStore, ansiPaint, chunkLineCount, computeRepoId, defaultConfig, heatColor, seededRng, type ChunkColor, type PublicQuestionView } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';
import type { MapJson, MapNode } from '../src/program.js';
import { ScriptedAnswerSource } from '../src/quiz/scripted-source.js';
import { allKeys, createSandbox, type Sandbox, question } from './helpers.js';

const LEAF = 'src/math.ts';
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (t: string): string => t.replace(ANSI_RE, '');
const dot = (c: ChunkColor): string => ansiPaint(c, '●');
const expl = (i: number) => `LEAKPROBE-EXPL-${i}`;

let s: Sandbox;
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
    stem: `LEAKPROBE-STEM-${i + 1}?`,
    options: [`w${i}-a`, `w${i}-correct`, `w${i}-b`, `w${i}-c`],
    correctIndex: 1,
    explanation: expl(i + 1),
    refs: [{ start: 2, end: 2 }],
    chunkLines: chunkLineCount(leaf),
  }));
  await new FsQuestionStore(s.root).save(leaf.id, qs);
}

type Q = Pick<PublicQuestionView, 'options'>;
const right = (q: Q) => q.options.find((o) => o.text.endsWith('-correct'))!.index as 0 | 1 | 2 | 3;
const wrong = (q: Q) => q.options.find((o) => !o.text.endsWith('-correct'))!.index as 0 | 1 | 2 | 3;

const flatten = (n: MapNode): MapNode[] => [n, ...n.children.flatMap(flatten)];
/** Nodes from the leaf up to the root, nearest first, excluding the leaf. */
function ancestorsOf(root: MapNode, id: string): MapNode[] {
  const walk = (n: MapNode, path: MapNode[]): MapNode[] | null => {
    if (n.id === id) return path;
    for (const c of n.children) {
      const hit = walk(c, [n, ...path]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, [])!;
}
async function map(): Promise<{ root: MapNode; leaf: MapNode }> {
  const r = await s.gotchea(['map', '--json']);
  const root = (JSON.parse(r.stdout) as MapJson).root;
  return { root, leaf: flatten(root).find((n) => n.id === LEAF)! };
}
/** Colour codes (31 red, 32 green, …) of the dots on a heatmap line, in order. */
const codes = (line: string): string[] => [...line.matchAll(new RegExp(`${ESC}\\[(\\d+)m●`, 'g'))].map((m) => m[1]!);
const CODE: Record<ChunkColor, string> = { grey: '90', red: '31', yellow: '33', green: '32' };

describe('no leak before answering (scripted source with a probe)', () => {
  it('stdout so far never contains an explanation, a line reference or a key, at any ask()', async () => {
    await seed();
    const src = new ScriptedAnswerSource([wrong, right, right]); // wrong at least once so the reveal path runs
    const run = await s.gotchea(['quiz', LEAF], { deps: { answerSource: src, rng: seededRng(9) }, color: true });
    const plain = strip(run.stdout);
    // The output is one stream; the text printed before the k-th question header is exactly what the user
    // saw when that question was asked. It may contain the reveals of questions 1..k-1 and nothing else.
    const offsets = [...plain.matchAll(/Question \d of 3/g)].map((m) => m.index!);
    expect(offsets).toHaveLength(3);
    const idx = (q: PublicQuestionView) => Number(q.questionId.slice(-12)); // seeded as q_…<i+1>; explanation = expl(i+1)
    for (const [k, off] of offsets.entries()) {
      const before = plain.slice(0, off);
      const asked = src.asked.slice(0, k).map(idx);
      for (let n = 1; n <= 3; n++) {
        if (asked.includes(n)) expect(before, `q${n} was answered before ask ${k + 1}`).toContain(expl(n));
        else expect(before, `before ask ${k + 1}: ${expl(n)}`).not.toContain(expl(n));
      }
      if (k === 0) {
        expect(before).not.toMatch(/Explanation|Look at|Correct answer|✅|❌|LEAKPROBE-EXPL|correctIndex/);
      }
    }
    // The text printed for a question (its header up to its answer) never has refs or keys either.
    expect(plain.slice(offsets[0]!, plain.indexOf('Explanation:'))).not.toMatch(/Look at|correctIndex/);
    // The question views handed to the source never carry more than the public keys.
    for (const q of src.asked) {
      expect(Object.keys(q).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total']);
      expect([...allKeys(q)].filter((k) => /correct|explanation|refs|Line/.test(k))).toEqual([]);
      expect(JSON.stringify(q)).not.toMatch(/LEAKPROBE-EXPL/);
    }
    // The reveal path did run: the wrong answer printed the key and the explanation.
    expect(plain).toMatch(/❌ Incorrect[\s\S]*Correct answer: [A-D]\) w\d-correct/);
  });

  it('a refused quiz (no questions) prints no answer data and the source is never asked', async () => {
    const src = new ScriptedAnswerSource([]);
    const r = await s.gotchea(['quiz'], { deps: { answerSource: src } });
    expect(r.code).toBe(1);
    expect(src.asked).toEqual([]);
    expect(r.stdout + r.stderr).not.toMatch(/correctIndex|EXPL|explanation/i);
  });
});

describe('ANSI heatmap after a quiz', () => {
  it('passing: red → green dots, 0% → 100%, and the heatmap matches `map --json` colour for colour', async () => {
    await seed();
    const cfg = defaultConfig().score;
    const beforeMap = await map();
    expect(beforeMap.leaf.state).toMatchObject({ color: 'red', R: 0 });

    const r = await s.gotchea(['quiz', LEAF], { color: true, deps: { answerSource: new ScriptedAnswerSource([right, right, right]), rng: seededRng(2) } });
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');

    // 1. Before/after dots on the summary line, from the colour function on R = 0 and R = 1.
    expect(heatColor(0, cfg)).toBe('red');
    expect(heatColor(1, cfg)).toBe('green');
    const summary = lines.find((l) => strip(l).includes('R 0% → 100%'))!;
    expect(summary, r.stdout).toBeDefined();
    expect(summary).toContain(`${dot('red')} → ${dot('green')}`);
    expect(strip(summary)).toMatch(/src\/math\.ts › .*\(R 0% → 100%\) · green until \d{4}-\d{2}-\d{2}/);
    expect(strip(r.stdout)).toMatch(/Quiz complete: 3\/3 correct \(needed \d\) — PASSED/);

    // 2. The heatmap block: the focus cell is green, and every ancestor equals the map's colour.
    const i = lines.findIndex((l) => strip(l).startsWith('Heatmap (src/math.ts)'));
    expect(i).toBeGreaterThan(0);
    const leafRow = lines[i + 1]!;
    expect(strip(leafRow)).toMatch(/^► ● /);
    expect(leafRow).toContain(`► ${dot('green')} `);
    const up = lines.find((l) => strip(l).startsWith('Up: '))!;
    const after = await map();
    expect(after.leaf.state.color).toBe('green');
    expect(after.leaf.state.R).toBe(1);
    expect(after.leaf.state.color).not.toBe(beforeMap.leaf.state.color);
    expect(codes(up)).toEqual(ancestorsOf(after.root, LEAF).map((n) => CODE[n.state.color]));

    // 3. The dots are the real colour function of the real retrievability, node by node.
    for (const n of flatten(after.root)) if (n.state.R !== null) expect(n.state.color, n.id).toBe(heatColor(n.state.R, cfg));

    // 4. The tree printed by `gotchea map` (ANSI) paints the same dot.
    const tree = (await s.gotchea(['map'], { color: true })).stdout;
    const leafLine = tree.split('\n').find((l) => strip(l).includes('math.ts') && l.includes('●') && !strip(l).includes('Up:'))!;
    expect(leafLine).toContain(dot('green'));
    expect(strip(leafLine)).toMatch(/100%/);

    // 5. Persisted: one history entry, progress is the source of the colour.
    const repoId = await computeRepoId(s.root);
    expect((await new FsProgressStore(repoId, s.env).load()).chunks[LEAF]!.history).toHaveLength(1);
  });

  it('failing: the chunk stays red, the heatmap and map agree, and no green dot appears for it', async () => {
    await seed();
    const r = await s.gotchea(['quiz', LEAF], { color: true, deps: { answerSource: new ScriptedAnswerSource([wrong, wrong, right]), rng: seededRng(5) } });
    expect(strip(r.stdout)).toContain('NOT PASSED');
    const summary = r.stdout.split('\n').find((l) => strip(l).includes('→') && strip(l).includes('src/math.ts ›'))!;
    expect(summary).toContain(`${dot('red')} → ${dot('red')}`);
    const lines = r.stdout.split('\n');
    const i = lines.findIndex((l) => strip(l).startsWith('Heatmap (src/math.ts)'));
    expect(lines[i + 1]).toContain(`► ${dot('red')} `);
    const { leaf, root } = await map();
    expect(leaf.state.color).toBe('red');
    const up = lines.find((l) => strip(l).startsWith('Up: '))!;
    expect(codes(up)).toEqual(ancestorsOf(root, LEAF).map((n) => CODE[n.state.color]));
    expect(strip(r.stdout)).toContain('This chunk must be passed again; it stays red until then.');
  });

  it('with colours off, letters and percentages carry the state and no escape codes are printed', async () => {
    await seed();
    const r = await s.gotchea(['quiz', LEAF], { color: false, deps: { answerSource: new ScriptedAnswerSource([right, right, right]), rng: seededRng(2) } });
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).toContain('[red] → [green]');
    expect(r.stdout).toMatch(/► \[G 100%\] /);
    expect(r.stdout).toMatch(/Up: \[G 100%\]/);
  });
});
