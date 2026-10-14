// Any OpenAI-compatible Chat Completions server (Ollama, vLLM, LM Studio, gateways).
// The API key is optional; `json_schema` falls back to `json_object` once if rejected.
import { type FetchLike, OpenAIChatProvider } from './openai-chat.js';

export interface OpenAICompatibleProviderOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  fetch?: FetchLike;
}

export function createOpenAICompatibleProvider(opts: OpenAICompatibleProviderOptions): OpenAIChatProvider {
  return new OpenAIChatProvider({
    name: 'openai-compatible',
    baseURL: opts.baseURL,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    model: opts.model,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    structured: 'json_schema',
    allowJsonObjectFallback: true,
  });
}
