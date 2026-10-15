import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateProvider, JsonRequest, LLMProvider } from 'gotchea-core';
import type { QuestionPrivate } from 'gotchea-core/internal';
import { run, type CliIo, type ProgramDeps } from '../src/program.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/small-repo', import.meta.url));
export const NOW = new Date('2026-10-14T12:00:00.000Z');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** Temp copy of the fixture repo. */
  root: string;
  /** Temp GOTCHEA_HOME (personal progress). */
  home: string;
  env: NodeJS.ProcessEnv;
  /** Runs `gotchea <args>` with `--cwd root` unless `cwd` is given. */
  gotchea: (args: string[], opts?: { cwd?: string; color?: boolean; deps?: ProgramDeps; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
  cleanup: () => Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'gotchea-cli-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'gotchea-cli-home-'));
  await cp(FIXTURE, root, { recursive: true });
  const env = { GOTCHEA_HOME: home };
  return {
    root,
    home,
    env,
    gotchea: async (args, opts = {}) => {
      let stdout = '';
      let stderr = '';
      const io: CliIo = {
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        cwd: opts.cwd ?? root,
        env: { ...env, ...opts.env },
        color: opts.color ?? false,
        now: () => NOW,
      };
      const code = await run(args, io, opts.deps);
      return { code, stdout, stderr };
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Every key in a JSON value, recursively. */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** An `ok` question with an answer key (to prove it never reaches the output). */
export const question = (chunkId: string, chunkHash: string): QuestionPrivate => ({
  id: 'q1',
  chunkId,
  chunkHash,
  type: 'behavior',
  stem: 'What does clamp return for n > hi?',
  options: ['lo', 'hi', 'n', 'NaN'],
  correctIndex: 1,
  explanation: 'The second guard returns hi.',
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
});

/** Sentinels a generated question carries; none may appear in any CLI output. */
export const GEN_SENTINELS = { option: 'GEN-OPT-SENTINEL', explanation: 'GEN-EXPL-SENTINEL', stem: 'GEN-STEM' } as const;

/**
 * Mock LLM provider for `generate`: answers each batch with valid questions whose
 * options, explanation and stems carry sentinels. Refs/citations use L1, valid in any chunk.
 */
export class SentinelProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model = 'mock';
  readonly requests: JsonRequest[] = [];
  #next = 0;

  static readonly STEMS = [
    'Why does this code guard its input before using it?',
    'What is produced when the collection argument is empty?',
    'Which change would break callers relying on this behaviour?',
    'How are values outside the expected range treated here?',
    'What goes wrong if the loop bound becomes inclusive?',
    'What does the caller observe after a successful call?',
    'Which assumption about the arguments does this code make?',
  ];

  async completeJson(req: JsonRequest): Promise<unknown> {
    this.requests.push(req);
    const count = Number(/Write (\d+) questions/.exec(req.user)![1]);
    return {
      questions: Array.from({ length: count }, () => {
        const i = this.#next++;
        return {
          type: 'behavior',
          stem: `${GEN_SENTINELS.stem} ${SentinelProvider.STEMS[i % SentinelProvider.STEMS.length]}`,
          options: ['alpha path', 'bravo path', 'charlie path', 'delta path'].map((o) => `${GEN_SENTINELS.option} ${o}`),
          correctIndex: i % 4,
          explanation: `${GEN_SENTINELS.explanation}: L1 shows why this option holds and the others do not.`,
          refs: [{ start: 1, end: 1 }],
          difficulty: 2,
        };
      }),
    };
  }

  deps(): { createProvider: CreateProvider } {
    return { createProvider: async () => this };
  }
}

/** Answer-bearing keys or generated sentinels found in `text` (empty when clean). Checks an answer-bearing key or any generated sentinel. */
export function answerDataIn(text: string): string[] {
  const hits: string[] = [];
  for (const s of Object.values(GEN_SENTINELS)) if (text.includes(s)) hits.push(s);
  for (const k of ['correctIndex', 'explanation', 'options', 'stem', 'refs']) if (new RegExp(`"${k}"\\s*:`).test(text)) hits.push(k);
  return hits;
}
