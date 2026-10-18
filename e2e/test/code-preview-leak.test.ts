import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORBIDDEN_KEYS } from '../../packages/core/src/quiz/views.js';
import type { GenerationTaskOut, StartQuizOut, SubmitAnswerOut } from '../../packages/mcp/src/schemas.js';
import { createHarness, type McpHarness } from '../src/harness.js';
import { ptyAvailable, runInPty } from '../src/pty.js';
import { correctTexts, fakeQuestions, privateExplanationMarker } from '../src/scenarios.js';

type Question = NonNullable<StartQuizOut['question']>;

// The source names the private fields on purpose: the preview is real code, and the leak scan
// must check object keys, not words inside the snippet.
const gradingPath = 'src/grading.ts';
const gradingSource = `/** A stored answer key; the explanation is revealed only after grading. */
export interface AnswerKey {
  correctIndex: number;
  explanation: string;
}

/** Grades one selection against its key. */
export function grade(selected: number, key: AnswerKey): { ok: boolean; explanation: string } {
  if (!Number.isInteger(selected) || selected < 0 || selected > 3) throw new RangeError('Selection out of range');
  return { ok: selected === key.correctIndex, explanation: key.explanation };
}
`;

// Correct option first; none of these appears in the source above.
const gradingBank = [
  ['What happens when grade receives a selection of seven?', ['A RangeError aborts the call', 'The result reports a miss', 'The selection wraps to three', 'An empty object comes back']],
  ['When does grade report a successful selection?', ['Only when it equals the stored index', 'Whenever the selection is non-negative', 'Whenever the key has any rationale', 'Only for the first displayed choice']],
  ['What shape does grade return for an accepted selection?', ['An object with two fields', 'A plain boolean flag value', 'A numeric score from zero', 'A promise of a verdict']],
  ['Which selection is still accepted by grade without throwing?', ['Three, the largest index', 'Four, one past the end', 'Negative one, a sentinel', 'One and a half, a fraction']],
  ['What does the AnswerKey interface model in this module?', ['A stored key with its rationale', 'A user session with its expiry', 'A display permutation table', 'A scoring threshold setting']],
  ['How does grade treat a fractional selection such as 1.5?', ['It throws before any comparison', 'It rounds down and compares', 'It rounds up and compares', 'It reports a miss quietly']],
] as const;
const gradingCorrect = new Map<string, string>(gradingBank.map(([stem, options]) => [stem, options[0]]));
const allCorrect = new Map([...correctTexts, ...gradingCorrect]);

const forbidden = new Set<string>(FORBIDDEN_KEYS);

/** Recursively rejects forbidden keys, also inside JSON text payloads; string values are only data. */
function assertNoForbiddenKeys(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { return; }
    assertNoForbiddenKeys(decoded, `${path}<json>`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertNoForbiddenKeys(entry, `${path}[${index}]`); });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      // A form schema names its empty response field `answer`; its contents are still scanned.
      const formResponse = path.endsWith('.requestedSchema.properties') && key === 'answer';
      expect(forbidden.has(key) && !formResponse, `Answer key leaked at ${path}.${key}`).toBe(false);
      assertNoForbiddenKeys(entry, `${path}.${key}`);
    }
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pre-answer text may show a correct option only as one of the four labelled options, never
 * anywhere else (a code comment, a header, a hint). The explanation may not appear at all.
 */
function assertNoAnswerText(text: string, where: string): void {
  expect(text, `Explanation leaked in ${where}`).not.toContain(privateExplanationMarker);
  for (const answer of allCorrect.values()) {
    for (const line of text.split('\n').filter((entry) => entry.includes(answer))) {
      expect(line, `Correct option text outside an option line in ${where}`).toMatch(new RegExp(`(^|[^\\w])[A-D]\\) ${escapeRegExp(answer)}\\s*$`));
    }
  }
}

/** Structured data: every string except an option's own text is checked. */
function assertNoAnswerData(value: unknown, where: string, path = '$'): void {
  if (typeof value === 'string') {
    if (/\.options\[\d\]\.text$/.test(path)) return;
    expect(value, `Explanation leaked at ${where} ${path}`).not.toContain(privateExplanationMarker);
    for (const answer of allCorrect.values()) {
      if (value.includes(answer)) assertNoAnswerText(value, `${where} ${path}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertNoAnswerData(entry, where, `${path}[${index}]`); });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoAnswerData(entry, where, `${path}.${key}`);
  }
}

function assertPreAnswerQuestion(question: Question, where: string): void {
  assertNoForbiddenKeys(question, where);
  assertNoAnswerData(question, where);
  const correct = allCorrect.get(question.stem);
  expect(correct, question.stem).toBeDefined();
  expect(question.options.filter((option) => option.text === correct)).toHaveLength(1);
  expect(Object.keys(question).sort()).toEqual(['options', 'position', 'questionId', 'stem', 'total', ...(question.code ? ['code'] : [])].sort());
}

it('C: detectors flag keys and answer text but not private words inside a code snippet', () => {
  const [stem, correct] = [...gradingCorrect][0]!;
  const options = [correct, 'x', 'y', 'z'].map((text, index) => ({ index, label: 'ABCD'[index], text }));
  const question = { questionId: 'q_000000000000', position: 1, total: 1, stem, options, code: { path: gradingPath, startLine: 1, endLine: 11, language: 'typescript', text: gradingSource.trimEnd() } };
  expect(() => assertNoForbiddenKeys(question)).not.toThrow();
  expect(() => assertNoAnswerData(question, 'clean')).not.toThrow();
  expect(() => assertNoAnswerText(`${stem}\n\nA) ${correct}\nB) x`, 'clean text')).not.toThrow();
  for (const key of FORBIDDEN_KEYS) {
    expect(() => assertNoForbiddenKeys({ ...question, code: { ...question.code, [key]: 0 } })).toThrow('Answer key leaked');
  }
  expect(() => assertNoAnswerData({ ...question, code: { ...question.code, text: `// ${correct}` } }, 'leak')).toThrow('Correct option text');
  expect(() => assertNoAnswerData({ ...question, code: { ...question.code, text: privateExplanationMarker } }, 'leak')).toThrow('Explanation leaked');
  expect(() => assertNoAnswerText(`Hint: ${correct}`, 'leak')).toThrow('Correct option text');
});

describe('C: quiz code previews never carry answers and disappear for stale chunks', () => {
  let harness: McpHarness;
  let gradingChunk: string;
  let gradingLines: { start: number; end: number };
  const preAnswerResults: { tool: string; result: unknown }[] = [];
  const answered = new Set<string>();

  /** Records a tool result as pre-answer output unless it carries a reveal. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await harness.callTool(name, args);
    if (name !== 'submit_answer') preAnswerResults.push({ tool: name, result });
    return result;
  }

  // Plain output so lines can be matched; an inherited FORCE_COLOR would override NO_COLOR.
  const plainEnv = () => {
    const { FORCE_COLOR: _, ...env } = harness.fixture.env;
    return { ...env, NO_COLOR: '1', TERM: 'xterm' };
  };

  /** `gotchea quiz` on the grading chunk in a pseudo-terminal, cancelled at the first question. */
  const cliQuiz = (extra: string[]) => runInPty([harness.target.command, ...harness.target.args, 'quiz', gradingPath, '--new', ...extra], {
    cwd: harness.fixture.root, env: plainEnv(), trigger: 'D) ',
  });

  async function chunkLines(path: string, id: string) {
    const chunks = (await call('get_chunk_for_file', { path })).structuredContent as { chunks: { id: string; ranges: { start: number; end: number }[] }[] };
    const chunk = chunks.chunks.find((entry) => entry.id === id);
    expect(chunk?.ranges, id).toHaveLength(1);
    return chunk!.ranges[0]!;
  }

  async function expectedCode(path: string, lines: { start: number; end: number }) {
    const source = (await readFile(join(harness.fixture.root, path), 'utf8')).split('\n');
    return { path, startLine: lines.start, endLine: lines.end, language: 'typescript', text: source.slice(lines.start - 1, lines.end).join('\n') };
  }

  beforeAll(async () => {
    harness = await createHarness();
    await writeFile(join(harness.fixture.root, gradingPath), gradingSource);
    await call('scan');
    const tasks = ((await call('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] }).tasks;
    const grading = tasks.find((task) => task.path === gradingPath);
    expect(grading, 'fixture chunk for src/grading.ts').toBeDefined();
    gradingChunk = grading!.chunkId;
    for (const task of tasks) {
      const questions = task === grading
        ? gradingBank.slice(0, task.count).map(([stem, options], index) => ({
          type: task.typePlan[index]!, stem, options: [...options], correctIndex: 0,
          explanation: `${privateExplanationMarker}: L1-L${task.lineCount} define the grading behavior this fixture question checks.`,
          refs: [{ start: 1, end: task.lineCount }], difficulty: 1,
        }))
        : fakeQuestions(task);
      expect(questions).toHaveLength(task.count);
      const saved = await call('save_questions', { chunkId: task.chunkId, chunkHash: task.chunkHash, lang: 'en', questions });
      expect(saved.structuredContent, task.chunkId).toMatchObject({ status: 'saved', savedCount: questions.length, rejected: [] });
    }
    gradingLines = await chunkLines(gradingPath, gradingChunk);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('MCP start_quiz and every next question carry the exact fresh source, without keys or answers', async () => {
    const code = await expectedCode(gradingPath, gradingLines);
    expect(code.text).toContain('correctIndex');
    expect(code.text).toContain('explanation');
    let response = await call('start_quiz', { chunkId: gradingChunk, lang: 'en' });
    const start = response.structuredContent as StartQuizOut;
    expect(start.status).toBe('started');
    let question = start.question;
    for (let index = 0; index < start.session!.total; index++) {
      expect(question).not.toBeNull();
      // Pre-answer for this question, even when it arrived as `next` beside the previous reveal.
      assertPreAnswerQuestion(question!, `question ${index + 1}`);
      expect(question!.code).toEqual(code);
      const shown = (response.content as { type: string; text?: string }[]).map((item) => item.type === 'text' ? item.text : '').join('\n');
      const relay = shown.split('<<<SHOW TO USER VERBATIM\n')[1]!.split('\nSHOW TO USER VERBATIM>>>')[0]!;
      expect(relay).toContain(`Code: ${gradingPath}:${code.startLine}-${code.endLine}\n`);
      expect(relay).toContain(`\`\`\`typescript\n${code.text}\n\`\`\``);
      expect(relay).toContain(question!.stem);
      for (const option of question!.options) expect(relay).toContain(`${option.label}) ${option.text}`);
      assertNoAnswerText(relay, `relay question ${index + 1}`);
      const correct = allCorrect.get(question!.stem)!;
      const option = question!.options.find((entry) => entry.text === correct)!;
      response = await harness.callTool('submit_answer', {
        sessionId: start.session!.id, questionId: question!.questionId, displayIndex: option.index,
      });
      const answer = response.structuredContent as SubmitAnswerOut;
      answered.add(question!.questionId);
      // The reveal is post-answer data; the explanation shows up there and only there.
      expect(answer.reveal).toMatchObject({ questionId: question!.questionId, correct: true, correctText: correct });
      expect(answer.reveal!.explanation).toContain(privateExplanationMarker);
      question = answer.next;
    }
    expect(question).toBeNull();
    expect(answered.size).toBe(start.session!.total);
  });

  it('every other pre-answer MCP output, text included, passes the key and answer-text scans', async () => {
    for (const task of ['src/math.ts', 'src/account.ts']) {
      const start = (await call('start_quiz', { chunkId: task, lang: 'en' })).structuredContent as StartQuizOut;
      expect(start.status).toBe('started');
      expect(start.question!.code).toEqual(await expectedCode(task, await chunkLines(task, task)));
    }
    await call('get_map');
    await call('get_status');
    await call('get_generation_tasks', { limit: 10, lang: 'en' });
    expect(new Set(preAnswerResults.map((entry) => entry.tool))).toEqual(new Set(['scan', 'get_generation_tasks', 'save_questions', 'get_chunk_for_file', 'start_quiz', 'get_map', 'get_status']));
    for (const { tool, result } of preAnswerResults) {
      assertNoForbiddenKeys(result, tool);
      const { content, structuredContent } = result as { content: { type: string; text?: string }[]; structuredContent: unknown };
      assertNoAnswerData(structuredContent, tool);
      for (const item of content) if (item.text !== undefined) assertNoAnswerText(item.text, `${tool} text`);
    }
    // The fenced snippet reaches the agent in the text payload too, with the private words intact.
    const quizText = preAnswerResults.filter((entry) => entry.tool === 'start_quiz')
      .flatMap((entry) => (entry.result as { content: { text?: string }[] }).content.map((item) => item.text ?? ''));
    expect(quizText.some((text) => text.includes('correctIndex: number;') && text.includes('```typescript'))).toBe(true);
  });

  it('opt-in elicitation messages and choice schemas pass the pre-answer scans', async () => {
    const client = new Client({ name: 'gotchea-e2e-elicitation', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const transport = new StdioClientTransport({
      command: harness.target.command,
      args: [...harness.target.args, 'mcp'],
      cwd: harness.fixture.root,
      env: { ...harness.fixture.env, GOTCHEA_MCP_ELICIT: 'on' },
      stderr: 'pipe',
    });
    let prompts = 0;
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts++;
      if (req.params.mode === 'url') throw new Error('Expected a form prompt');
      assertNoForbiddenKeys(req.params, 'elicitation');
      assertNoAnswerText(req.params.message, 'elicitation message');
      assertNoAnswerData(req.params.requestedSchema, 'elicitation schema');
      expect(req.params.message).toContain('correctIndex: number;');
      expect(req.params.message).toMatch(/\d+ │ /);
      expect(req.params.message).not.toContain('```typescript');
      return { action: 'cancel' };
    });
    try {
      await client.connect(transport, { timeout: 120_000 });
      const result = await client.callTool({ name: 'start_quiz', arguments: { chunkId: gradingChunk, lang: 'en' } });
      expect((result.structuredContent as StartQuizOut).status).toBe('cancelled');
      expect(prompts).toBe(1);
      assertNoForbiddenKeys(result, 'elicitation cancellation');
    } finally {
      try { await client.close(); } finally { await transport.close(); }
    }
  });

  it('CLI --json outputs carry no keys, question text, answers or code previews', async () => {
    const outputs = [
      await harness.runCli(['scan', '--json']),
      await harness.runCli(['status', '--json']),
      await harness.runCli(['map', '--json']),
      await harness.runCli(['generate', '--dry-run', '--json']),
    ];
    for (const [index, { stdout }] of outputs.entries()) {
      const data = JSON.parse(stdout) as unknown;
      assertNoForbiddenKeys(data, `cli json ${index}`);
      assertNoAnswerData(data, `cli json ${index}`);
      expect(stdout).not.toMatch(/"(code|stem|options)":/);
      for (const stem of allCorrect.keys()) expect(stdout).not.toContain(stem);
    }
  });

  it.skipIf(!ptyAvailable())('CLI quiz prints the fresh source before the first answer, and --no-code hides it', async () => {
    const run = (extra: string[]) => cliQuiz(extra);
    const header = `${gradingPath}:${gradingLines.start}-${gradingLines.end} (typescript)`;
    const shown = await run([]);
    expect(shown.triggered, `${shown.status}\n${shown.text}`).toBe(true);
    expect(shown.text).toContain(header);
    expect(shown.text).toMatch(/\d+ │ {3}correctIndex: number;/);
    expect(shown.text).toContain('Quiz abandoned, nothing was scored.');
    assertNoAnswerText(shown.text, 'cli quiz');
    const hidden = await run(['--no-code']);
    expect(hidden.triggered, `${hidden.status}\n${hidden.text}`).toBe(true);
    expect(hidden.text).not.toContain(header);
    expect(hidden.text).not.toContain('correctIndex');
    assertNoAnswerText(hidden.text, 'cli quiz --no-code');
  });

  it('after an unscanned source edit the preview is left out over MCP and the CLI, other chunks keep theirs', async () => {
    const edited = gradingSource.replace("RangeError('Selection out of range')", "RangeError('Selection must be 0-3')");
    expect(edited).not.toBe(gradingSource);
    await writeFile(join(harness.fixture.root, gradingPath), edited);
    const stale = await harness.callTool('start_quiz', { chunkId: gradingChunk, lang: 'en' });
    const data = stale.structuredContent as StartQuizOut;
    expect(data.status).toBe('started');
    assertPreAnswerQuestion(data.question!, 'stale start_quiz');
    expect(data.question).not.toHaveProperty('code');
    assertNoForbiddenKeys(stale, 'stale start_quiz');
    for (const item of stale.content as { text?: string }[]) {
      expect(item.text ?? '').not.toContain('```');
      assertNoAnswerText(item.text ?? '', 'stale start_quiz text');
    }
    // Staleness is per chunk: an untouched file still gets its preview.
    const fresh = (await harness.callTool('start_quiz', { chunkId: 'src/math.ts', lang: 'en' })).structuredContent as StartQuizOut;
    expect(fresh.question!.code?.path).toBe('src/math.ts');

    if (ptyAvailable()) {
      const cli = await cliQuiz([]);
      expect(cli.triggered, `${cli.status}\n${cli.text}`).toBe(true);
      expect(cli.text).not.toContain(`${gradingPath}:`);
      expect(cli.text).not.toContain('correctIndex');
      assertNoAnswerText(cli.text, 'stale cli quiz');
    }
  });
});

describe('C: terminal control sequences in source reach the CLI quiz only as visible stand-ins', () => {
  let harness: McpHarness;
  const bannerPath = 'src/banner.ts';
  // An OSC 8 hyperlink and a clear-screen, written raw into the working tree.
  const osc8 = '\u001b]8;;http://evil\u0007';
  const clear = '\u001b[2J';
  const bannerSource = `/** Shown at startup: ${osc8}docs${osc8} then ${clear}. */
export function banner(name: string): string {
  if (name.length === 0) throw new RangeError('Name must not be empty');
  const trimmed = name.trim();
  if (trimmed.length > 40) throw new RangeError('Name is too long');
  return \`Welcome, \${trimmed}\`;
}

/** The banner width, in columns. */
export const BANNER_WIDTH = 40;
`;
  const bannerBank = [
    ['What does banner do with an empty name?', ['It throws a RangeError', 'It returns an empty string', 'It greets an anonymous user', 'It returns undefined']],
    ['What does banner return for a non-empty name?', ['A greeting with the name', 'The name in upper case', 'The length of the name', 'A boolean success flag']],
    ['Which type does banner accept as its argument?', ['A string', 'A number', 'An array of strings', 'An options object']],
    ['When does banner build its greeting?', ['After the empty-name check', 'Before validating input', 'Only on the second call', 'Only when logging is on']],
    ['What kind of value does banner produce?', ['A template string', 'A promise of a string', 'A tuple of strings', 'A string buffer']],
    ['How does banner report invalid input?', ['By throwing', 'By returning null', 'By logging a warning', 'By returning false']],
  ] as const;

  beforeAll(async () => {
    harness = await createHarness();
    await writeFile(join(harness.fixture.root, bannerPath), bannerSource);
    await harness.callTool('scan');
    const tasks = ((await harness.callTool('get_generation_tasks', { limit: 10, lang: 'en' })).structuredContent as { tasks: GenerationTaskOut[] }).tasks;
    const task = tasks.find((entry) => entry.path === bannerPath);
    expect(task, 'fixture chunk for src/banner.ts').toBeDefined();
    const questions = bannerBank.slice(0, task!.count).map(([stem, options], index) => ({
      type: task!.typePlan[index]!, stem, options: [...options], correctIndex: 0,
      explanation: `${privateExplanationMarker}: L1-L${task!.lineCount} define the banner behavior.`,
      refs: [{ start: 1, end: task!.lineCount }], difficulty: 1,
    }));
    expect(questions).toHaveLength(task!.count);
    const saved = await harness.callTool('save_questions', { chunkId: task!.chunkId, chunkHash: task!.chunkHash, lang: 'en', questions });
    expect(saved.structuredContent).toMatchObject({ status: 'saved', savedCount: questions.length, rejected: [] });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it.skipIf(!ptyAvailable())('the CLI preview prints no ESC with colours off and shows U+241B instead', async () => {
    const { FORCE_COLOR: _, ...env } = harness.fixture.env;
    const run = await runInPty([harness.target.command, ...harness.target.args, 'quiz', bannerPath, '--new'], {
      cwd: harness.fixture.root, env: { ...env, NO_COLOR: '1', TERM: 'xterm' }, trigger: 'D) ',
    });
    expect(run.triggered, `${run.status}\n${run.text}`).toBe(true);
    expect(run.text).toContain('Quiz abandoned, nothing was scored.');
    // Everything gotchea prints itself (header, code preview) comes before the prompt library
    // draws, and carries no ESC at all.
    const own = run.raw.slice(0, run.raw.indexOf('\u001b') < 0 ? undefined : run.raw.indexOf('\u001b'));
    expect(own).toContain(`${bannerPath}:1-`);
    expect(own).toContain(' 1 │ /** Shown at startup: ␛]8;;http://evil␇docs␛]8;;http://evil␇ then ␛[2J. */');
    expect(own).not.toContain('\u001b');
    // The prompt library moves the cursor with its own CSI codes; past that allowlist (note `ESC[J`,
    // erase below, is allowed but `ESC[2J`, clear screen, is not), no ESC or BEL is left anywhere.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the prompt's cursor codes
    const rest = run.raw.replace(/\u001b\[(?:\?25[lh]|\d*[ABCD]|J)/g, '');
    expect(rest).not.toContain('\u001b');
    expect(rest).not.toContain('\u0007');
    expect(run.raw).not.toContain(osc8);
    expect(run.raw).not.toContain(clear);
  });
});
