// Chat Completions over fetch (M2_DESIGN.md §6), shared by `openai` and
// `openai-compatible`. fetch is injected so tests never touch the network.
import type { ProviderName } from '../../config/schema.js';
import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, ProviderError, parseJsonText, type JsonRequest, type LLMProvider } from './provider.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** `json_schema` = strict structured outputs; `json_object` = JSON mode with the schema in the prompt. */
export type StructuredMode = 'json_schema' | 'json_object';

export interface OpenAIChatProviderOptions {
  name: Extract<ProviderName, 'openai' | 'openai-compatible'>;
  baseURL: string;
  /** Sent as a Bearer token when set. */
  apiKey?: string;
  model: string;
  fetch?: FetchLike;
  /** Starting mode; `openai-compatible` falls back to `json_object` once if the server rejects `json_schema`. */
  structured?: StructuredMode;
  /** Allow the one-time `json_object` fallback (on for openai-compatible). */
  allowJsonObjectFallback?: boolean;
}

interface ChatChoice {
  finish_reason?: string | null;
  message?: { content?: string | null; refusal?: string | null };
}

/** Longest error body excerpt quoted in an error message. */
const MAX_ERROR_BODY = 300;

export class OpenAIChatProvider implements LLMProvider {
  readonly name: OpenAIChatProviderOptions['name'];
  readonly model: string;
  readonly baseURL: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #allowFallback: boolean;
  #mode: StructuredMode;

  constructor(opts: OpenAIChatProviderOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey || undefined;
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#mode = opts.structured ?? 'json_schema';
    this.#allowFallback = opts.allowJsonObjectFallback ?? opts.name === 'openai-compatible';
  }

  /** The structured-output mode the next request will use. */
  get mode(): StructuredMode {
    return this.#mode;
  }

  async completeJson(req: JsonRequest): Promise<unknown> {
    const signal = req.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    let res = await this.#post(req, this.#mode, signal);
    if (!res.ok && res.status === 400 && this.#mode === 'json_schema' && this.#allowFallback && /response_format|json_schema/i.test(res.body)) {
      res = await this.#post(req, 'json_object', signal);
      if (res.ok) this.#mode = 'json_object';
    }
    if (!res.ok) {
      // A gateway may echo the request headers; never print the key, even partially.
      const body = this.#apiKey ? res.body.split(this.#apiKey).join('[redacted]') : res.body;
      throw new ProviderError('http', `${this.#label()} HTTP ${res.status}: ${body.slice(0, MAX_ERROR_BODY)}`, { status: res.status });
    }

    let payload: { choices?: ChatChoice[] } | null;
    try {
      payload = JSON.parse(res.body) as { choices?: ChatChoice[] } | null;
    } catch (err) {
      throw new ProviderError('invalid_json', `${this.#label()} returned a response that is not JSON`, { cause: err });
    }
    // `null` is valid JSON; reading `.choices` off it would throw a raw TypeError.
    const choice = payload?.choices?.[0];
    if (!choice?.message) throw new ProviderError('invalid_json', `${this.#label()} returned no choices`);
    if (choice.message.refusal) throw new ProviderError('refusal', `${this.#label()} declined the request`);
    if (choice.finish_reason === 'length') throw new ProviderError('truncated', `${this.#label()} hit the token limit before finishing the JSON`);
    if (typeof choice.message.content !== 'string') throw new ProviderError('invalid_json', `${this.#label()} returned no message content`);
    return parseJsonText(choice.message.content, this.#label());
  }

  #label(): string {
    return `${this.name}:${this.model}`;
  }

  async #post(req: JsonRequest, mode: StructuredMode, signal: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
    const system =
      mode === 'json_schema' ? req.system : `${req.system}\n\nRespond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
    // OpenAI deprecated `max_tokens`; most compatible servers only know it.
    const tokenParam = this.name === 'openai' ? 'max_completion_tokens' : 'max_tokens';
    const body = {
      model: this.model,
      [tokenParam]: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.user },
      ],
      response_format:
        mode === 'json_schema' ? { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } } : { type: 'json_object' },
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey) headers['authorization'] = `Bearer ${this.#apiKey}`;
    try {
      const res = await this.#fetch(`${this.baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (err) {
      const safe = safeUrl(this.baseURL);
      // undici quotes the full request URL in some messages (e.g. URLs with credentials).
      const detail = (err instanceof Error ? err.message : String(err)).split(this.baseURL).join(safe);
      throw new ProviderError('network', `Could not reach ${safe}: ${detail}`, { cause: err });
    }
  }
}

/** Origin + path only: a base URL may carry `user:token@` or an `?api-key=` query. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid base URL>';
  }
}
