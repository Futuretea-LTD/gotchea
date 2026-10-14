// OpenAI (api.openai.com) over the shared Chat Completions implementation.
import { type FetchLike, OpenAIChatProvider } from './openai-chat.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** Default OPENAI_BASE_URL. */
  baseURL?: string;
  fetch?: FetchLike;
}

export function createOpenAIProvider(opts: OpenAIProviderOptions): OpenAIChatProvider {
  return new OpenAIChatProvider({
    name: 'openai',
    baseURL: opts.baseURL ?? OPENAI_BASE_URL,
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    structured: 'json_schema',
  });
}
