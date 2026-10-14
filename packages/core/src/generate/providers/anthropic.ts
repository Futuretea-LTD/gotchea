// Anthropic Messages API provider (M2_DESIGN.md §6): structured outputs via
// `output_config.format`, no forced tool use, no sampling parameters, server-side
// refusal fallback on. The client is injected; factory.ts builds the real SDK client.
import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, ProviderError, parseJsonText, type JsonRequest, type LLMProvider } from './provider.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> }; effort?: 'low' | 'medium' | 'high' };
  betas: string[];
  fallbacks: 'default';
}

export interface AnthropicMessage {
  stop_reason: string | null;
  content: readonly { type: string; text?: string }[];
}

/** The slice of `@anthropic-ai/sdk`'s client this provider uses, so tests can inject a fake. */
export interface AnthropicClientLike {
  beta: { messages: { create(params: AnthropicCreateParams, options?: { signal?: AbortSignal }): Promise<AnthropicMessage> } };
}

export interface AnthropicProviderOptions {
  client: AnthropicClientLike;
  model?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  readonly #client: AnthropicClientLike;

  constructor(opts: AnthropicProviderOptions) {
    this.#client = opts.client;
    this.model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
  }

  async completeJson(req: JsonRequest): Promise<unknown> {
    const params: AnthropicCreateParams = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: { type: 'json_schema', schema: req.schema }, ...(req.effort ? { effort: req.effort } : {}) },
      betas: [ANTHROPIC_FALLBACK_BETA],
      fallbacks: 'default',
    };
    let res: AnthropicMessage;
    try {
      res = await this.#client.beta.messages.create(params, { signal: req.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    if (res.stop_reason === 'refusal') throw new ProviderError('refusal', `anthropic:${this.model} declined the request`);
    if (res.stop_reason === 'max_tokens') throw new ProviderError('truncated', `anthropic:${this.model} hit max_tokens before finishing the JSON`);
    const text = res.content.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
    if (text === undefined) throw new ProviderError('invalid_json', `anthropic:${this.model} returned no text block`);
    return parseJsonText(text, `anthropic:${this.model}`);
  }
}

/**
 * SDK errors by shape, so the SDK stays a lazy import: `APIError` carries a numeric
 * `status`; connection, timeout and abort errors carry none.
 */
export function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') return new ProviderError('http', `Anthropic API error ${status}: ${message}`, { status, cause: err });
  return new ProviderError('network', `Could not reach the Anthropic API: ${message}`, { cause: err });
}
