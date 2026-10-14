// Common provider contract (M2_DESIGN.md §6). A provider turns a system + user
// prompt and a JSON Schema into parsed JSON; validating it is the caller's job.
import type { ProviderName } from '../../config/schema.js';
import { RAW_BATCH_JSON_SCHEMA, RawBatchSchema, type RawBatch } from '../schema.js';
import type { PromptPair } from '../prompt.js';

export type { ProviderName } from '../../config/schema.js';

export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface JsonRequest {
  system: string;
  user: string;
  /** JSON Schema object of the expected output. */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Default DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** generate: 'medium', verify: 'low'. */
  effort?: 'low' | 'medium' | 'high';
  /** Default `AbortSignal.timeout(DEFAULT_TIMEOUT_MS)`. */
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** Parsed JSON; validation is the caller's job. Throws ProviderError. */
  completeJson(req: JsonRequest): Promise<unknown>;
}

export type ProviderErrorCode = 'missing_api_key' | 'missing_model' | 'http' | 'refusal' | 'truncated' | 'invalid_json' | 'network';

/** Messages describe the failure only; they never carry model output or prompt text. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** Configuration errors abort a run; the rest are per-request failures. */
export function isConfigError(err: unknown): err is ProviderError {
  return err instanceof ProviderError && (err.code === 'missing_api_key' || err.code === 'missing_model');
}

/** '<provider>:<model>', as stored in `generatedBy` / `verifiedBy`. */
export function providerLabel(p: Pick<LLMProvider, 'name' | 'model'>): string {
  return `${p.name}:${p.model}`;
}

/** Parses model text as JSON, mapping failure to `invalid_json`. */
export function parseJsonText(text: string, provider: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError('invalid_json', `${provider} returned output that is not valid JSON`, { cause: err });
  }
}

/**
 * Requests a question batch for a generation prompt (`buildGenerationPrompt` /
 * `buildSystemPrompt` + `buildUserPrompt`) and parses the envelope with
 * RawBatchSchema. Items stay `unknown`: the validator reports them per index.
 */
export async function requestQuestionBatch(
  provider: LLMProvider,
  prompt: PromptPair,
  opts: Pick<JsonRequest, 'maxTokens' | 'signal'> = {},
): Promise<RawBatch> {
  const raw = await provider.completeJson({
    system: prompt.system,
    user: prompt.user,
    schema: RAW_BATCH_JSON_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'question_batch',
    effort: 'medium',
    ...opts,
  });
  const parsed = RawBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ProviderError('invalid_json', `${providerLabel(provider)} returned JSON that is not a question batch (${where}${issue?.message ?? 'invalid'})`);
  }
  return parsed.data;
}
