// Optional blind verify pass (M2_DESIGN.md §5). A fresh model answers the question
// from the code alone, with options permuted; disagreeing with the key flags it.
// Provider-agnostic: the caller passes an `answer` callback (e.g. a provider's completeJson).
import { sha256Hex } from '../hash/hash.js';
import { buildVerifyPrompt, type VerifyPromptInput } from './prompt.js';
import { VERIFY_ANSWER_JSON_SCHEMA, VerifyAnswerSchema } from './schema.js';

export interface VerifyRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  effort: 'low';
}

/** Returns the model's parsed JSON answer (`{ answerIndex, confidence }`). */
export type AnswerFn = (req: VerifyRequest) => Promise<unknown>;

export interface VerifyOutcome {
  flagged: boolean;
  /** Set when the verify completed; null when it failed. */
  verifiedBy: string | null;
  /** Failure message (provider error or malformed answer); never contains the key. */
  error?: string;
}

export interface BlindVerifyInput {
  answer: AnswerFn;
  /** '<provider>:<model>' recorded on the question. */
  verifier: string;
  task: VerifyPromptInput['task'];
  question: { stem: string; options: readonly [string, string, string, string]; correctIndex: number };
  /** Permutation seed; the question id. */
  seed: string;
}

/**
 * Deterministic permutation of 4 options seeded by `seed`:
 * `perm[displayIndex] = originalIndex`.
 */
export function optionPermutation(seed: string, n = 4): number[] {
  const bytes = sha256Hex(`verify\n${seed}`);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const r = Number.parseInt(bytes.slice((i % 16) * 4, (i % 16) * 4 + 4), 16);
    const j = r % (i + 1);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm;
}

export async function blindVerify(input: BlindVerifyInput): Promise<VerifyOutcome> {
  const perm = optionPermutation(input.seed, input.question.options.length);
  const options = perm.map((orig) => input.question.options[orig]!);
  const prompt = buildVerifyPrompt({ task: input.task, stem: input.question.stem, options });
  let raw: unknown;
  try {
    raw = await input.answer({
      ...prompt,
      schema: VERIFY_ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'verify_answer',
      effort: 'low',
    });
  } catch (err) {
    return { flagged: false, verifiedBy: null, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = VerifyAnswerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.answerIndex >= options.length) {
    return { flagged: false, verifiedBy: null, error: 'verifier returned an invalid answer' };
  }
  const answered = perm[parsed.data.answerIndex]!;
  return { flagged: answered !== input.question.correctIndex, verifiedBy: input.verifier };
}
