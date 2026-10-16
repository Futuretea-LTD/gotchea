// Builds a provider from config + env (M2_DESIGN.md §6). Reads only the `env`
// passed in, never process.env. The Anthropic SDK is imported lazily so the
// OpenAI paths and the MCP server never load it.
import type { GotcheaConfig, ProviderName } from '../../config/schema.js';
import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider, type AnthropicClientLike } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createOpenAIProvider } from './openai.js';
import type { FetchLike } from './openai-chat.js';
import { ProviderError, type LLMProvider } from './provider.js';

export const PROVIDER_NAMES = ['anthropic', 'openai', 'openai-compatible'] as const satisfies readonly ProviderName[];

/** The env var holding each provider's API key. */
export const API_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': 'OPENAI_COMPAT_API_KEY',
};

export interface CreateProviderOptions {
  config: Pick<GotcheaConfig, 'provider'>;
  env: Readonly<Record<string, string | undefined>>;
  /** `--model`; wins over `config.provider.models[name]`. */
  model?: string;
  /** Transport for the OpenAI paths (default global fetch). */
  fetch?: FetchLike;
  /** Pre-built Anthropic client (tests); skips the SDK import. */
  anthropicClient?: AnthropicClientLike;
}

export type CreateProvider = (name: ProviderName, opts: CreateProviderOptions) => Promise<LLMProvider>;

const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

function resolveModel(name: ProviderName, opts: CreateProviderOptions): string {
  const model = nonEmpty(opts.model) ?? nonEmpty(opts.config.provider.models[name] ?? undefined);
  if (model) return model;
  if (name === 'anthropic') return ANTHROPIC_DEFAULT_MODEL;
  throw new ProviderError('missing_model', `No model set for ${name}: pass --model <id> or set provider.models["${name}"] in .gotchea/config.json.`);
}

function requireKey(name: ProviderName, env: CreateProviderOptions['env']): string {
  const key = nonEmpty(env[API_KEY_ENV[name]]);
  if (!key) throw new ProviderError('missing_api_key', `${API_KEY_ENV[name]} is not set.`);
  return key;
}

/** Throws ProviderError for invalid provider configuration before any request is made. */
export const createProvider: CreateProvider = async (name, opts) => {
  switch (name) {
    case 'anthropic': {
      const apiKey = opts.anthropicClient ? undefined : requireKey(name, opts.env);
      const model = resolveModel(name, opts);
      const client = opts.anthropicClient ?? (await sdkClient(apiKey!, nonEmpty(opts.env['ANTHROPIC_BASE_URL'])));
      return new AnthropicProvider({ client, model });
    }
    case 'openai': {
      const apiKey = requireKey(name, opts.env);
      const baseURL = nonEmpty(opts.env['OPENAI_BASE_URL']);
      return createOpenAIProvider({
        apiKey,
        model: resolveModel(name, opts),
        ...(baseURL ? { baseURL } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    }
    case 'openai-compatible': {
      const apiKey = nonEmpty(opts.env[API_KEY_ENV[name]]);
      return createOpenAICompatibleProvider({
        baseURL: nonEmpty(opts.env['OPENAI_COMPAT_BASE_URL']) ?? opts.config.provider.baseUrl,
        model: resolveModel(name, opts),
        ...(apiKey ? { apiKey } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    }
    default:
      throw new ProviderError('unknown_provider', `unknown provider ${String(name satisfies never)}; valid providers: ${PROVIDER_NAMES.join(', ')}`);
  }
};

async function sdkClient(apiKey: string, baseURL: string | undefined): Promise<AnthropicClientLike> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const sdk = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  // A typed adapter: the SDK's overloaded `create` checks our params against its own types.
  return { beta: { messages: { create: (params, options) => sdk.beta.messages.create({ ...params, stream: false }, options) } } };
}
