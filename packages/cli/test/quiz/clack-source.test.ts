import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_KEYS, FsChunkStore, FsProgressStore, chunkLineCount, computeRepoId, seededRng } from 'gotchea-core';
import { FsQuestionStore, type QuestionPrivate } from 'gotchea-core/internal';

// Mocked prompt library. Every call is recorded with a snapshot of the CLI output at that moment,
// so the tests can prove what was on screen when each question was asked.
const CANCEL = Symbol('clack:cancel');
interface Call {
  fn: string;
  arg: unknown;
  outputBefore: string;
}
interface SelectArg {
  message: string;
  options: { value: number; label: string }[];
}
type Decider = (arg: SelectArg) => unknown;

const calls: Call[] = [];
const selectScript: Decider[] = [];
const confirmScript: unknown[] = [];
let probe: () => string = () => '';

vi.mock('@clack/prompts', () => {
  const record = (fn: string, arg: unknown) => void calls.push({ fn, arg, outputBefore: probe() });
  return {
    isCancel: (v: unknown) => v === CANCEL,
    select: async (arg: SelectArg) => {
      record('select', arg);
      const step = selectScript.shift();
      if (!step) throw new Error('clack select: script exhausted');
      const v = step(arg);
      if (v instanceof Error) throw v;
      return v;
    },
    confirm: async (arg: unknown) => {
      record('confirm', arg);
      if (confirmScript.length === 0) throw new Error('clack confirm: script exhausted');
      return confirmScript.shift();
    },
    // Not used today; recorded so a future leak through any of them is still caught.
    intro: (m: unknown) => record('intro', m),
    outro: (m: unknown) => record('outro', m),
    note: (m: unknown) => record('note', m),
    log: Object.fromEntries(['info', 'message', 'step', 'warn', 'error', 'success'].map((k) => [k, (m: unknown) => record(`log.${k}`, m)])),
  };
});

import { run, type CliIo } from '../../src/program.js';
import { ClackAnswerSource, isInteractive } from '../../src/quiz/clack-source.js';
import { NOW, createSandbox, type Sandbox } from '../helpers.js';

let s: Sandbox;
const LEAF = 'src/math.ts';
const STREAMS = ['stdin', 'stdout'] as const;
const savedTty = new Map<string, PropertyDescriptor | undefined>();

function setTty(stdin: boolean | undefined, stdout: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true });
}

beforeEach(async () => {
  calls.length = 0;
  selectScript.length = 0;
  confirmScript.length = 0;
  probe = () => '';
  for (const k of STREAMS) savedTty.set(k, Object.getOwnPropertyDescriptor(process[k], 'isTTY'));
  setTty(true, true);
  s = await createSandbox();
  await s.gotchea(['init']);
  await s.gotchea(['scan']);
});
afterEach(async () => {
  for (const k of STREAMS) {
    const d = savedTty.get(k);
    if (d) Object.defineProperty(process[k], 'isTTY', d);
    else delete (process[k] as { isTTY?: boolean }).isTTY;
  }
  await s.cleanup();
});

// Option texts are neutral, so a marker like "correct" can only reach the output if the code printed it.
const EXPLANATION = (n: number) => `EXPL-SECRET-${n}-zq`;
const STEM = (n: number) => `STEM-${n}-quux?`;
const KEY_TEXT = (n: number) => `opt-${n}-bravo`;
const qNo = (stem: string) => Number(/STEM-(\d+)-/.exec(stem)![1]);

async function seed(n = 3): Promise<void> {
  const leaf = (await new FsChunkStore(s.root).load())!.chunks.find((c) => c.id === LEAF)!;
  const qs: QuestionPrivate[] = Array.from({ length: n }, (_, i) => ({
    id: `q_${String(i + 1).padStart(12, '0')}`,
    chunkId: leaf.id,
    chunkHash: leaf.contentHash,
    type: 'behavior',
    stem: STEM(i + 1),
    options: [`opt-${i + 1}-alpha`, KEY_TEXT(i + 1), `opt-${i + 1}-charlie`, `opt-${i + 1}-delta`],
    correctIndex: 1,
    explanation: EXPLANATION(i + 1),
    refs: [{ start: 2, end: 2 }],
    difficulty: 1,
    lang: 'en',
    generatedBy: 'test',
    status: 'ok',
    flagged: false,
    chunkLines: chunkLineCount(leaf),
    promptVersion: 'p1',
    verifiedBy: null,
    createdAt: NOW.toISOString(),
  }));
  await new FsQuestionStore(s.root).save(leaf.id, qs);
}

/** Picks the display index of the right (or a wrong) option of the question being shown. */
const choose = (right: boolean): Decider => (arg) => arg.options.find((o) => o.label.includes(KEY_TEXT(qNo(arg.message))) === right)!.value;
const cancel: Decider = () => CANCEL;
const crash: Decider = () => new Error('terminal went away');

/** Real `gotchea quiz` run with the mocked clack source; output is probed live. */
async function quiz(steps: Decider[], confirms: unknown[] = [], args: string[] = []) {
  selectScript.push(...steps);
  confirmScript.push(...confirms);
  let stdout = '';
  let stderr = '';
  probe = () => stdout + stderr;
  const io: CliIo = { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), cwd: s.root, env: s.env, color: false, now: () => NOW };
  const code = await run(['quiz', LEAF, ...args], io, { rng: seededRng(8) });
  return { code, stdout, stderr };
}

const asked = () => calls.filter((c) => c.fn === 'select');
const shownToClack = () => JSON.stringify(calls.map((c) => ({ fn: c.fn, arg: c.arg })));
const progress = async () => (await new FsProgressStore(await computeRepoId(s.root), s.env).load()).chunks[LEAF];

describe('ClackAnswerSource', () => {
  it('maps the picked display index to an answer and labels each option', async () => {
    selectScript.push(() => 2);
    const choice = await new ClackAnswerSource().ask({
      questionId: 'q',
      position: 1,
      total: 1,
      stem: 'Which?',
      options: [
        { index: 0, label: 'A', text: 'zero' },
        { index: 1, label: 'B', text: 'one' },
        { index: 2, label: 'C', text: 'two' },
        { index: 3, label: 'D', text: 'three' },
      ],
    } as never);
    expect(choice).toEqual({ kind: 'answer', displayIndex: 2 });
    expect(calls[0]!.arg).toEqual({
      message: 'Which?',
      options: [
        { value: 0, label: 'A) zero' },
        { value: 1, label: 'B) one' },
        { value: 2, label: 'C) two' },
        { value: 3, label: 'D) three' },
      ],
    });
  });

  it('turns Ctrl+C on a question into quit', async () => {
    selectScript.push(cancel);
    expect(await new ClackAnswerSource().ask({ questionId: 'q', position: 1, total: 1, stem: 's', options: [] } as never)).toEqual({ kind: 'quit' });
  });

  it('confirm: passes the default through, and treats yes, no and Ctrl+C correctly', async () => {
    const src = new ClackAnswerSource();
    confirmScript.push(true, false, CANCEL, true);
    expect(await src.confirm('resume?')).toBe(true);
    expect(await src.confirm('resume?', false)).toBe(false);
    expect(await src.confirm('resume?')).toBe(false); // cancel is never a yes
    await src.confirm('x', false);
    expect(calls.map((c) => (c.arg as { initialValue: boolean }).initialValue)).toEqual([true, false, true, false]);
  });

  it('isInteractive needs both stdin and stdout to be a TTY', () => {
    expect(isInteractive()).toBe(true);
    setTty(true, false);
    expect(isInteractive()).toBe(false);
    setTty(false, true);
    expect(isInteractive()).toBe(false);
    setTty(undefined, undefined);
    expect(isInteractive()).toBe(false);
  });
});

describe('gotchea quiz on the clack source', () => {
  it('without a TTY and without an injected source it refuses (exit 2), asking nothing', async () => {
    setTty(false, false);
    const r = await quiz([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('interactive terminal');
    expect(calls).toHaveLength(0);
  });

  it('(a) right answers: select gets the labelled options and the quiz is scored as passed', async () => {
    await seed();
    const r = await quiz([choose(true), choose(true), choose(true)]);
    expect(r.code).toBe(0);
    expect(asked()).toHaveLength(3);
    for (const c of asked()) {
      const arg = c.arg as SelectArg;
      expect(Object.keys(arg).sort()).toEqual(['message', 'options']);
      expect(arg.options.map((o) => o.value)).toEqual([0, 1, 2, 3]);
      expect(arg.options.map((o) => o.label.slice(0, 3))).toEqual(['A) ', 'B) ', 'C) ', 'D) ']);
      for (const o of arg.options) expect(Object.keys(o).sort()).toEqual(['label', 'value']);
    }
    expect(r.stdout.match(/✅ Correct\./g)).toHaveLength(3);
    expect(r.stdout).toMatch(/Quiz complete: 3\/3 correct .* PASSED/);
    expect((await progress())!.history).toHaveLength(1);
  });

  it('(b) Ctrl+C abandons the quiz cleanly: exit 0, nothing scored, nothing left to resume', async () => {
    await seed();
    const r = await quiz([choose(true), cancel]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Quiz abandoned, nothing was scored.');
    expect(await progress()).toBeUndefined();

    // The cancelled session is gone: a new run starts fresh and never offers to resume.
    const again = await quiz([choose(true), choose(true), choose(true)]);
    expect(again.stdout).toContain('Quiz: ');
    expect(again.stdout).not.toContain('Resumed');
    expect(calls.filter((c) => c.fn === 'confirm')).toHaveLength(0);
    expect(again.stdout).toMatch(/Quiz complete: 3\/3/);
  });

  it('(c) a quiz cut off midway (prompt dies) is resumed on the next run when the user says yes', async () => {
    await seed();
    const first = await quiz([choose(true), crash]).catch((e: unknown) => e);
    // The failure surfaces as a non-zero exit or a throw; either way the session stays on disk.
    expect(first instanceof Error || (first as { code: number }).code !== 0).toBe(true);
    expect(await progress()).toBeUndefined();

    calls.length = 0;
    const r = await quiz([choose(true), choose(true)], [true]);
    const confirms = calls.filter((c) => c.fn === 'confirm');
    expect(confirms).toHaveLength(1);
    expect((confirms[0]!.arg as { message: string }).message).toMatch(/Resume your unfinished quiz.*1\/3 answered/);
    expect(r.stdout).toContain('Resumed');
    expect(asked()).toHaveLength(2); // only the two unanswered questions
    expect(r.stdout).toMatch(/Quiz complete: 3\/3/);
    expect((await progress())!.history).toHaveLength(1);
  });

  it('(c) declining the resume abandons the old session and starts a fresh quiz; Ctrl+C at the prompt counts as no', async () => {
    await seed();
    await quiz([choose(true), crash]).catch(() => undefined);
    calls.length = 0;
    const declined = await quiz([cancel], [CANCEL]);
    expect(declined.stdout).toContain('Quiz: ');
    expect(declined.stdout).not.toContain('Resumed');
    expect((asked()[0]!.arg as SelectArg).message).toMatch(/STEM-/);
    expect(declined.stdout).toContain('Quiz abandoned');
    // And --new skips the question entirely.
    await quiz([choose(true), crash], [], ['--new']).catch(() => undefined);
    expect(calls.filter((c) => c.fn === 'confirm')).toHaveLength(1); // the one above, none added by --new
  });

  it('(d) a wrong answer reveals the right option and the explanation only afterwards', async () => {
    await seed();
    const r = await quiz([choose(false), choose(true), choose(true)]);
    expect(r.stdout).toContain('❌ Incorrect. You chose');
    expect(r.stdout).toMatch(/Correct answer: [A-D]\) opt-\d-bravo/);
    expect(r.stdout).toContain('Explanation: EXPL-SECRET-');
    expect(r.stdout).toContain('NOT PASSED');
    const first = asked()[0]!;
    expect(first.outputBefore).not.toContain('Incorrect');
    expect(first.outputBefore).not.toContain('Correct answer');
    expect(first.outputBefore).not.toContain('Explanation');
  });

  it('never shows the answer key to clack or the terminal before a question is answered', async () => {
    await seed();
    const r = await quiz([choose(false), choose(true), choose(false)]);
    expect(r.code).toBe(0);
    expect(asked()).toHaveLength(3);

    // Everything handed to clack (options, labels, any note/log/intro/outro) carries no key and no reveal text.
    const toClack = shownToClack();
    for (const k of FORBIDDEN_KEYS) expect(toClack, `clack payload has key ${k}`).not.toMatch(new RegExp(`"${k}"\\s*:`));
    expect(toClack).not.toContain('EXPL-SECRET');
    expect(toClack).not.toMatch(/Correct answer|Explanation|✅|❌|correct/i);
    expect(calls.every((c) => c.fn === 'select')).toBe(true);

    // Output on screen at the moment question n is asked has none of its reveal, and no forbidden key at all.
    for (const c of asked()) {
      const n = qNo((c.arg as SelectArg).message);
      expect(c.outputBefore, `output before q${n}`).not.toContain(EXPLANATION(n));
      for (const k of FORBIDDEN_KEYS) expect(c.outputBefore).not.toMatch(new RegExp(`"${k}"\\s*:`));
    }
    // The reveal of question n arrives only after its select, and each explanation exactly once.
    for (let n = 1; n <= 3; n++) {
      expect(r.stdout.split(EXPLANATION(n))).toHaveLength(2);
      const askedAt = asked().find((c) => qNo((c.arg as SelectArg).message) === n)!.outputBefore.length;
      expect(r.stdout.indexOf(EXPLANATION(n))).toBeGreaterThanOrEqual(askedAt);
    }
    // Only the explanation and the correct text the reveal prints; no raw JSON keys anywhere.
    for (const k of FORBIDDEN_KEYS) expect(r.stdout + r.stderr).not.toMatch(new RegExp(`"${k}"\\s*:`));
    expect(r.stderr).toBe('');
  });
});
